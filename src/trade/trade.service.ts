import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Trade as PrismaTrade, TradeRoute } from '@prisma/client';
import {
    Connection,
    Keypair,
    ParsedTransactionWithMeta,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import axios from 'axios';
import bs58 from 'bs58';
import * as https from 'https';
import * as path from 'path';
import { DexLimiter } from '../common/dex-limiter';
import { JupiterLimiter, JupiterPriority } from '../common/jupiter-limiter';
import { PendingSellStore } from '../common/pending-sell-store';
import { computeNetProfitUsd } from '../common/fee-utils';
import { selectBestDexScreenerPair } from '../common/dex-pair';
import {
    RpcEndpointPool,
    RpcErrorClass,
    classifyRpcError,
    computeBackoffDelay,
    isAmbiguousSendFailure,
    isRetryableRpcError,
    parseRpcEndpoints,
} from '../common/rpc-retry';
import {
    isWithdrawalsEnabled,
    parseChatIdList,
    validateWithdrawAccess,
    WithdrawGuardReason,
} from '../common/withdraw-guard';
import { TokenMetadata, TradeExecutionPayload } from '../dto/analyzer.dto';
import { PrismaService } from '../prisma/prisma.service';
import {
    BuyExecutionOptions,
    BuyRiskConfig,
    BuyRiskMetrics,
    TradeAuditFields,
} from '../dto/trade.dto';
import { ReportingService } from '../reporting/reporting.service';
import { TelegramWorkspaceService } from '../telegram/telegram-workspace.service';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

export function resolveUsableSolPrice(
    livePrice: number | null,
    cachedPrice: number | null,
    cachedAt: number | null,
    now: number,
    maxCacheAgeMs: number,
): number | null {
    if (typeof livePrice === 'number' && Number.isFinite(livePrice) && livePrice > 0) {
        return livePrice;
    }
    if (
        typeof cachedPrice === 'number' &&
        Number.isFinite(cachedPrice) &&
        cachedPrice > 0 &&
        typeof cachedAt === 'number' &&
        Number.isFinite(cachedAt) &&
        now - cachedAt >= 0 &&
        now - cachedAt <= Math.max(0, maxCacheAgeMs)
    ) {
        return cachedPrice;
    }
    return null;
}

export function capBuyPositionUsd(
    requestedUsd: number,
    maxPositionUsd: number,
    spendableAfterReserveUsd: number,
    maxWalletPct: number,
): number {
    const walletCapUsd =
        Math.max(spendableAfterReserveUsd, 0) * (Math.min(Math.max(maxWalletPct, 0), 100) / 100);
    return Math.max(0, Math.min(requestedUsd, maxPositionUsd, walletCapUsd));
}

/**
 * The stop-loss/trailing reference must come from the same feed PriceMonitorService reads.
 *
 * A live example: $fatdog filled on-chain at $0.00007837 while DexScreener still reported
 * $0.00007198 — an 8.16% gap that instantly tripped the 8% stop 1.7 seconds after entry. The
 * position was actually flat; it sold at $0.00007796, a real loss of 0.54%, and that phantom
 * loss then counted toward MAX_CONSECUTIVE_LOSSES and locked the risk breaker.
 *
 * Falls back to the on-chain fill when the feed price is unusable, which is the pre-existing
 * behaviour.
 */
export function resolveMonitorEntryPriceSol(
    feedPriceUsd: number | undefined,
    solPriceUsd: number,
    onChainEntryPriceSol: number,
): number {
    const feedPrice = Number(feedPriceUsd);
    const solPrice = Number(solPriceUsd);
    if (!Number.isFinite(feedPrice) || feedPrice <= 0) return onChainEntryPriceSol;
    if (!Number.isFinite(solPrice) || solPrice <= 0) return onChainEntryPriceSol;

    const feedPriceSol = feedPrice / solPrice;
    return Number.isFinite(feedPriceSol) && feedPriceSol > 0 ? feedPriceSol : onChainEntryPriceSol;
}

export function calculateMinimumExecutablePositionUsd(
    configuredMinimumUsd: number,
    estimatedRoundtripFeeSol: number,
    solPriceUsd: number,
    maxFeePercent: number,
): number {
    const configured = Math.max(0, configuredMinimumUsd);
    if (
        !Number.isFinite(estimatedRoundtripFeeSol) ||
        estimatedRoundtripFeeSol <= 0 ||
        !Number.isFinite(solPriceUsd) ||
        solPriceUsd <= 0 ||
        !Number.isFinite(maxFeePercent) ||
        maxFeePercent <= 0
    ) {
        return configured;
    }
    return Math.max(configured, (estimatedRoundtripFeeSol * solPriceUsd) / (maxFeePercent / 100));
}

export function evaluateBuySignalGuard(input: {
    signalObservedAt?: number;
    signalPriceUsd?: number;
    quotePriceUsd?: number;
    now: number;
    maxSignalAgeMs: number;
    maxChasePct: number;
}): string | null {
    if (input.signalObservedAt && input.now - input.signalObservedAt > input.maxSignalAgeMs) {
        return 'buy_signal_stale';
    }
    if (
        input.signalPriceUsd &&
        input.signalPriceUsd > 0 &&
        input.quotePriceUsd &&
        input.quotePriceUsd > input.signalPriceUsd * (1 + input.maxChasePct / 100)
    ) {
        return `buy_price_chase: signal=${input.signalPriceUsd}, quote=${input.quotePriceUsd}, maxPct=${input.maxChasePct}`;
    }
    return null;
}

export function calculateRoundtripLossPct(
    inputLamports: string | number,
    reverseOutputLamports: string | number,
): number | null {
    const input = Number(inputLamports);
    const reverseOutput = Number(reverseOutputLamports);
    if (
        !Number.isFinite(input) ||
        input <= 0 ||
        !Number.isFinite(reverseOutput) ||
        reverseOutput < 0
    ) {
        return null;
    }
    return ((input - reverseOutput) / input) * 100;
}

export class TokenDecimalsUnavailableError extends Error {
    constructor(public readonly mint: string) {
        super(`Token decimals unavailable for ${mint}`);
        this.name = 'TokenDecimalsUnavailableError';
    }
}

export class PriceAnomalyError extends Error {
    constructor(
        public readonly mint: string,
        public readonly calculatedPrice: number,
        public readonly jupiterPrice: number,
        public readonly deviation: number,
    ) {
        super(
            `Price anomaly for ${mint}: calculated=${calculatedPrice}, jupiter=${jupiterPrice}, deviation=${deviation}`,
        );
        this.name = 'PriceAnomalyError';
    }
}

export function validateSellPrice(
    calculatedPrice: number,
    jupiterPrice: number | null,
    tokenMint: string,
    logger?: Pick<Logger, 'warn'>,
): number {
    const calculatedValid = Number.isFinite(calculatedPrice) && calculatedPrice > 0;
    const jupiterValid = jupiterPrice !== null && Number.isFinite(jupiterPrice) && jupiterPrice > 0;

    if (!calculatedValid && !jupiterValid) {
        throw new PriceAnomalyError(tokenMint, calculatedPrice, jupiterPrice || 0, Infinity);
    }
    if (calculatedValid && !jupiterValid) return calculatedPrice;
    const validJupiterPrice = jupiterPrice as number;
    if (!calculatedValid && jupiterValid) return validJupiterPrice;

    const deviation = Math.abs(calculatedPrice - validJupiterPrice) / validJupiterPrice;
    if (deviation <= 0.1) return calculatedPrice;
    if (deviation <= 0.25) {
        logger?.warn(
            `[${tokenMint}] Sell price deviation ${(deviation * 100).toFixed(2)}%. Calculated=${calculatedPrice}, Jupiter=${validJupiterPrice}. Using Jupiter price.`,
        );
        return validJupiterPrice;
    }

    throw new PriceAnomalyError(tokenMint, calculatedPrice, validJupiterPrice, deviation);
}

export function calculateCleanSwapSolAmount(
    rawSolDeltaLamports: number,
    networkFeeLamports: number,
    rentDeltaLamports: number,
    jitoTipLamports: number,
    side: 'BUY' | 'SELL' = 'BUY',
): { cleanSolAmount: number | null; totalFeesSol: number } {
    // rawSolDeltaLamports comes from tx1 (the swap) only. The Jito tip is paid in a
    // SEPARATE transaction (tx2) and is therefore NOT present in rawSolDeltaLamports,
    // so it must NOT be applied to the price math here. ATA rent IS in tx1's delta,
    // so it is still removed to isolate the true swap SOL amount.
    const cleanLamports =
        side === 'SELL'
            ? rawSolDeltaLamports + networkFeeLamports - rentDeltaLamports
            : rawSolDeltaLamports - networkFeeLamports - rentDeltaLamports;

    // Fee accounting: network fee + Jito tip are real costs. ATA rent is a recoverable
    // deposit (refunded when the ATA closes on sell), so it nets to ~zero over a round
    // trip and is NOT counted as a fee on either leg.
    const totalFeesSol = (networkFeeLamports + jitoTipLamports) / 1_000_000_000;

    return {
        cleanSolAmount: cleanLamports > 0 ? cleanLamports / 1_000_000_000 : null,
        totalFeesSol,
    };
}

export function resolveSafeSellSolPrice(
    liveSolPrice: number,
    entrySolPrice: number | null | undefined,
): { solPrice: number; source: 'live' | 'entry_fallback' | 'unavailable' } {
    if (Number.isFinite(liveSolPrice) && liveSolPrice > 0) {
        return { solPrice: liveSolPrice, source: 'live' };
    }
    const entry = Number(entrySolPrice ?? 0);
    if (Number.isFinite(entry) && entry > 0) {
        return { solPrice: entry, source: 'entry_fallback' };
    }
    return { solPrice: 0, source: 'unavailable' };
}

export type TradeScaleInMergeInput = {
    existingAmountInSol: number;
    existingEntryPriceSol: number;
    existingEntryValueUsd?: number | null;
    existingSolPriceAtEntry?: number | null;
    existingHighestPriceSol?: number | null;
    existingTotalFeesSol?: number | null;
    fillAmountInSol: number;
    fillEntryPriceSol: number;
    fillEntryValueUsd: number;
    fillSolPriceUsd: number;
    fillActualTokenAmount?: number | null;
    fillTotalFeesSol?: number | null;
};

export type TradeScaleInMergeResult = {
    mergedAmountInSol: number;
    mergedEntryPriceSol: number;
    mergedEntryValueUsd: number;
    mergedSolPriceAtEntry: number;
    mergedHighestPriceSol: number;
    mergedTotalFeesSol: number;
    existingTokenAmount: number;
    fillTokenAmount: number;
    totalTokenAmount: number;
};

export type ScaleInTrailingStopInput = {
    existingTrailingStopPrice: number;
    mergedEntryPriceSol: number;
    fillEntryPriceSol: number;
};

export function mergeTradeScaleInPosition(input: TradeScaleInMergeInput): TradeScaleInMergeResult {
    const existingAmountInSol = Math.max(0, input.existingAmountInSol || 0);
    const fillAmountInSol = Math.max(0, input.fillAmountInSol || 0);
    const existingEntryPriceSol = Math.max(0, input.existingEntryPriceSol || 0);
    const fillEntryPriceSol = Math.max(0, input.fillEntryPriceSol || 0);
    const existingEntryValueUsd =
        Number.isFinite(input.existingEntryValueUsd ?? Number.NaN) &&
        (input.existingEntryValueUsd ?? 0) > 0
            ? Number(input.existingEntryValueUsd)
            : existingAmountInSol *
              Math.max(0, input.existingSolPriceAtEntry ?? input.fillSolPriceUsd ?? 0);
    const fillEntryValueUsd = Math.max(0, input.fillEntryValueUsd || 0);
    const existingTokenAmount =
        existingEntryPriceSol > 0 ? existingAmountInSol / existingEntryPriceSol : 0;
    const fillTokenAmount =
        Number.isFinite(input.fillActualTokenAmount ?? Number.NaN) &&
        (input.fillActualTokenAmount ?? 0) > 0
            ? Number(input.fillActualTokenAmount)
            : fillEntryPriceSol > 0
              ? fillAmountInSol / fillEntryPriceSol
              : 0;
    const totalTokenAmount = existingTokenAmount + fillTokenAmount;
    const mergedAmountInSol = existingAmountInSol + fillAmountInSol;
    const mergedEntryValueUsd = existingEntryValueUsd + fillEntryValueUsd;
    const mergedEntryPriceSol =
        totalTokenAmount > 0
            ? mergedAmountInSol / totalTokenAmount
            : fillEntryPriceSol || existingEntryPriceSol;
    const mergedSolPriceAtEntry =
        mergedAmountInSol > 0
            ? mergedEntryValueUsd / mergedAmountInSol
            : Math.max(0, input.fillSolPriceUsd || 0);
    const mergedHighestPriceSol = Math.max(
        existingAmountInSol > 0
            ? Math.max(0, input.existingHighestPriceSol ?? existingEntryPriceSol)
            : 0,
        fillEntryPriceSol,
        mergedEntryPriceSol,
    );
    const mergedTotalFeesSol =
        Math.max(0, input.existingTotalFeesSol ?? 0) + Math.max(0, input.fillTotalFeesSol ?? 0);

    return {
        mergedAmountInSol,
        mergedEntryPriceSol,
        mergedEntryValueUsd,
        mergedSolPriceAtEntry,
        mergedHighestPriceSol,
        mergedTotalFeesSol,
        existingTokenAmount,
        fillTokenAmount,
        totalTokenAmount,
    };
}

export function resolveScaleInTrailingStopPrice(input: ScaleInTrailingStopInput): number {
    const existingStop = Math.max(0, input.existingTrailingStopPrice || 0);
    if (existingStop <= 0) return 0;

    const mergedEntryPriceSol = Math.max(0, input.mergedEntryPriceSol || 0);
    const fillEntryPriceSol = Math.max(0, input.fillEntryPriceSol || 0);
    if (mergedEntryPriceSol <= 0 || fillEntryPriceSol <= 0) return existingStop;

    // A scale-in changes the position cost basis. Do not keep a stale trailing stop
    // below the new blended entry because it can turn a previously protected winner
    // into an immediate net-loss exit. If the latest fill is already above the new
    // blended entry, move the stop to breakeven while keeping it below the live fill
    // price to avoid instant liquidation on the next monitor tick. Otherwise reset
    // trailing activation so PriceMonitor can re-arm once the merged position is
    // profitable again.
    if (existingStop < mergedEntryPriceSol) {
        return fillEntryPriceSol > mergedEntryPriceSol
            ? Math.min(mergedEntryPriceSol, fillEntryPriceSol * 0.999)
            : 0;
    }

    // If the prior stop is at/above the latest fill price, cap it just below the
    // current execution price. This avoids an immediate sell caused by a stale stop
    // after increasing position size.
    if (existingStop >= fillEntryPriceSol) {
        return fillEntryPriceSol * 0.999;
    }

    return existingStop;
}

export type JitoSwapDecisionInput = {
    useJitoConfigured: boolean;
    retryCount: number;
    swapNotionalUsd: number;
    jitoMinPositionUsd: number;
};

export function resolveJitoMinPositionUsd(rawValue?: string | null, fallback = 7): number {
    const parsed = Number.parseFloat(rawValue ?? '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function shouldUseJitoForSwap(input: JitoSwapDecisionInput): boolean {
    if (!input.useJitoConfigured) return false;
    if (input.retryCount !== 0) return false;
    const minPositionUsd =
        Number.isFinite(input.jitoMinPositionUsd) && input.jitoMinPositionUsd > 0
            ? input.jitoMinPositionUsd
            : 7;
    return input.swapNotionalUsd >= minPositionUsd;
}

export function calculateRealizedSellPnl(params: {
    solSpent: number;
    solReceived: number;
    entrySolPrice?: number | null;
    sellSolPrice?: number | null;
}): {
    solProfitPercent: number;
    usdSpent: number;
    usdReceived: number;
    usdProfit: number;
    usdProfitPercent: number;
} {
    const solSpent = Number(params.solSpent);
    const solReceived = Number(params.solReceived);
    const entrySolPrice = Number(params.entrySolPrice ?? 0);
    const sellSolPrice = Number(params.sellSolPrice ?? 0);
    const solProfitPercent = solSpent > 0 ? ((solReceived - solSpent) / solSpent) * 100 : 0;
    const usdSpent =
        solSpent *
        (Number.isFinite(entrySolPrice) && entrySolPrice > 0 ? entrySolPrice : sellSolPrice);
    const usdReceived =
        solReceived *
        (Number.isFinite(sellSolPrice) && sellSolPrice > 0 ? sellSolPrice : entrySolPrice);
    const usdProfit = usdReceived - usdSpent;
    const usdProfitPercent = usdSpent > 0 ? (usdProfit / usdSpent) * 100 : solProfitPercent;

    return {
        solProfitPercent,
        usdSpent,
        usdReceived,
        usdProfit,
        usdProfitPercent,
    };
}
export function sanitizeBuySizeMultiplier(value: number | undefined, fallback = 1): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(Math.max(numeric, 0.1), 1);
}

export function calculateFinalBuySizeUsd(
    baseSizeUsd: number,
    routeMultiplier: number,
    aiMultiplier: number | undefined,
): number {
    return (
        baseSizeUsd *
        sanitizeBuySizeMultiplier(routeMultiplier) *
        sanitizeBuySizeMultiplier(aiMultiplier)
    );
}

export function normalizePriceImpactPct(raw: string | number | null | undefined): number {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return 999;
    if (numeric > 0 && numeric < 1) return numeric * 100;
    return numeric;
}

export function capSlippageBps(requestedSlippageBps: number, maxSlippageBps: number): number {
    const requested = Number.isFinite(requestedSlippageBps) ? requestedSlippageBps : 100;
    const max = Number.isFinite(maxSlippageBps) && maxSlippageBps > 0 ? maxSlippageBps : 100;
    return Math.max(1, Math.min(Math.round(requested), Math.round(max)));
}

export function resolveRiskLookbackStart(
    riskPnlStartAt: Date | null | undefined,
    lookbackHours: number,
    nowMs: number = Date.now(),
): Date | null {
    const candidates: number[] = [];
    if (riskPnlStartAt && Number.isFinite(riskPnlStartAt.getTime())) {
        candidates.push(riskPnlStartAt.getTime());
    }
    if (Number.isFinite(lookbackHours) && lookbackHours > 0) {
        candidates.push(nowMs - lookbackHours * 60 * 60 * 1000);
    }
    if (candidates.length === 0) return null;
    return new Date(Math.max(...candidates));
}

export function evaluateBuyRisk(
    metrics: BuyRiskMetrics,
    config: BuyRiskConfig,
    totalCapitalUsd: number,
    nowMs: number = Date.now(),
): { allowed: boolean; reason?: string } {
    if (config.disabledUntilMs !== null && nowMs < config.disabledUntilMs) {
        return { allowed: false, reason: 'disabled_until' };
    }
    if (config.dailyMaxLossUsd > 0 && metrics.dailyRealizedPnlUsd <= -config.dailyMaxLossUsd) {
        return { allowed: false, reason: 'daily_max_loss' };
    }
    if (
        config.maxConsecutiveLosses > 0 &&
        metrics.consecutiveLosses >= config.maxConsecutiveLosses
    ) {
        return { allowed: false, reason: 'max_consecutive_losses' };
    }
    if (config.maxDrawdownPct > 0) {
        const maxLoss = (Math.max(totalCapitalUsd, 0) * config.maxDrawdownPct) / 100;
        if (maxLoss > 0 && metrics.totalRealizedPnlUsd <= -maxLoss) {
            return { allowed: false, reason: 'max_drawdown' };
        }
    }
    return { allowed: true };
}

function normalizeBuyFailureReason(rawReason: string): string {
    const text = String(rawReason || '').toLowerCase();
    if (text.includes('max_drawdown') || text.includes('max drawdown')) return 'risk_max_drawdown';
    if (text.includes('daily_max_loss') || text.includes('daily max loss'))
        return 'risk_daily_max_loss';
    if (text.includes('consecutive')) return 'risk_max_consecutive_losses';
    if (text.includes('disabled_until') || text.includes('disabled until'))
        return 'risk_disabled_until';
    if (text.includes('slot_limit') || text.includes('slot_guard') || text.includes('slot guard'))
        return 'slot_guard';
    if (text.includes('capital_guard') || text.includes('capital guard')) return 'capital_guard';
    if (text.includes('fee_floor_guard') || text.includes('fee floor')) return 'fee_floor_guard';
    if (
        text.includes('insufficient_balance') ||
        text.includes('balance_guard') ||
        text.includes('insufficient sol balance') ||
        text.includes('balance guard')
    )
        return 'balance_guard';
    if (text.includes('invalid_price_or_amount')) return 'invalid_price_or_amount';
    if (text.includes('already_open_trade')) return 'already_open_trade';
    if (text.includes('cooldown')) return 'cooldown';
    if (text.includes('price_impact_guard') || text.includes('price impact'))
        return 'price_impact_guard';
    if (
        text.includes('quote') ||
        text.includes('decimals_unavailable') ||
        text.includes('cancelled_decimals_unavailable')
    )
        return 'jupiter_quote_failed';
    if (text.includes('confirm')) return 'confirmation_failed';
    if (text.includes('swap')) return 'swap_failed';
    return rawReason || 'unknown_execution_failure';
}

function normalizeBuyFailureStage(reason: string): 'PRE_SWAP' | 'QUOTE' | 'SWAP' | 'CONFIRMATION' {
    const normalized = normalizeBuyFailureReason(reason);
    if (
        [
            'risk_max_drawdown',
            'risk_daily_max_loss',
            'risk_max_consecutive_losses',
            'risk_disabled_until',
            'capital_guard',
            'fee_floor_guard',
            'slot_guard',
            'balance_guard',
            'invalid_price_or_amount',
            'already_open_trade',
            'cooldown',
        ].includes(normalized)
    ) {
        return 'PRE_SWAP';
    }
    if (['price_impact_guard', 'jupiter_quote_failed'].includes(normalized)) {
        return 'QUOTE';
    }
    if (normalized === 'confirmation_failed') {
        return 'CONFIRMATION';
    }
    return 'SWAP';
}

@Injectable()
export class TradeService implements OnModuleInit {
    private readonly logger = new Logger(TradeService.name);
    private connection: Connection;
    private readonly sellingTrades = new Set<number>();
    private readonly decimalsCache = new Map<string, number>();
    private readonly sellRetryCounts = new Map<number, number>();
    private readonly priceAnomalyCounts = new Map<number, number>();
    private lastKnownSolPriceUsd: number | null = null;
    private lastKnownSolPriceAt: number | null = null;
    // Consecutive SELL failures per trade, used to escalate a stop-loss that is
    // repeatedly failing while the position is still OPEN (proposal solana-stoploss-retry).
    private readonly consecutiveSellFailures = new Map<number, number>();
    // Post-broadcast UNCONFIRMED sell tx signatures per trade. When a sell tx was
    // broadcast but its confirmation was AMBIGUOUS (e.g. confirmTransaction threw a
    // transient 429/timeout while the tx blockhash was still valid and propagating),
    // the deterministic tx signature is recorded here so the NEXT executeSell
    // reconciles that exact tx on-chain BEFORE re-selling. This closes the double-sell
    // race that a raceable balance snapshot alone cannot: within the tx validity window
    // the balance still shows the un-sold tokens, so a blind re-sell would double-execute
    // (proposal solana-stoploss-retry, requirement 3).
    //
    // DISK-BACKED (finding: idempotency state was process-local): the in-memory Map
    // alone was lost on restart, so a crash/restart within the tx validity window
    // dropped the pending record and let startMonitoringAllTrades re-sell a still-
    // in-flight tx (oversell on partial exits). PendingSellStore persists each
    // set/delete to a JSON file (atomic write) and rehydrates on load(), so the
    // reconciliation gate survives a restart. Same get/set/delete surface as the Map
    // it replaced; fail-soft (a persistence I/O error never blocks a sell).
    private readonly pendingSellSignatures: PendingSellStore;
    private rpcPool!: RpcEndpointPool;
    private jitoTipAccounts: string[] = [];

    private readonly totalCapital: number;
    private readonly reserveAmount: number;
    private readonly totalSlots: number;
    private readonly positionSizeUSD: number;
    private readonly micinPositionSizeMultiplier: number;
    private readonly whalePositionSizeMultiplier: number;
    private readonly slippageBps: number;
    private readonly jupiterApiKey: string;
    private readonly httpsAgent: https.Agent;

    // Cache for resolved IPs
    private ipCache: Record<string, string> = {
        '1.1.1.1': '1.1.1.1',
        '8.8.8.8': '8.8.8.8',
    };
    private readonly fallbackApiIps: Record<string, string> = {
        'api.jup.ag': '18.239.105.107',
        'quote-api.jup.ag': '104.26.11.233',
        'price.jup.ag': '104.26.10.233',
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly moduleRef: ModuleRef,
        private readonly telegramWorkspace: TelegramWorkspaceService,
    ) {
        this.rpcPool = new RpcEndpointPool(
            parseRpcEndpoints(
                this.configService.get<string>('SOLANA_RPC_URL'),
                this.configService.get<string>('RPC_ENDPOINT'),
                this.configService.get<string>('SOLANA_RPC_FALLBACKS'),
            ),
        );
        this.connection = new Connection(this.rpcPool.current, 'confirmed');
        this.logger.log(
            `[RPC] Endpoint pool initialized with ${this.rpcPool.size} endpoint(s); primary active.`,
        );
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';

        // Disk-backed idempotency store for post-broadcast unconfirmed sells.
        // Prune window matches the reconciliation TTL used by resolveSignatureFate
        // (SELL_UNCONFIRMED_TTL_MS, default 90s): past that window a re-sell is safe
        // regardless, so a persisted entry older than it carries no idempotency value.
        const idempotencyTtl = Number.parseInt(
            this.configService.get<string>('SELL_UNCONFIRMED_TTL_MS', '90000'),
            10,
        );
        const storePath =
            this.configService.get<string>('SELL_IDEMPOTENCY_STORE_PATH') ||
            path.join(process.cwd(), '.data', 'pending-sell-signatures.json');
        this.pendingSellSignatures = new PendingSellStore(
            storePath,
            Number.isFinite(idempotencyTtl) && idempotencyTtl > 0 ? idempotencyTtl : 90_000,
            undefined, // real fs
            (msg) => this.logger.warn(msg),
        );

        // CONFIG BUDGET (Updated by Amirull)
        this.totalCapital = Number.parseFloat(
            this.configService.get<string>('TOTAL_CAPITAL', '20'),
        );
        this.reserveAmount = Number.parseFloat(
            this.configService.get<string>('RESERVE_AMOUNT', '8'),
        ); // $20 - (4 slots * $3) = $8 reserve
        this.totalSlots = Number.parseInt(this.configService.get<string>('TOTAL_SLOTS', '4'), 10);
        this.positionSizeUSD = Number.parseFloat(
            this.configService.get<string>('POSITION_SIZE_USD', '3'),
        );
        this.micinPositionSizeMultiplier = Number.parseFloat(
            this.configService.get<string>('MICIN_POSITION_SIZE_MULTIPLIER', '0.7'),
        );
        this.whalePositionSizeMultiplier = Number.parseFloat(
            this.configService.get<string>('WHALE_POSITION_SIZE_MULTIPLIER', '1'),
        );

        this.slippageBps = Number.parseInt(
            this.configService.get<string>('SLIPPAGE_BPS', '100'),
            10,
        );

        // Inisialisasi DNS Hardening HTTPS Agent dengan keepAlive
        this.httpsAgent = new https.Agent({
            family: 4,
            keepAlive: true,
            lookup: async (hostname, options, cb) => {
                try {
                    const ip = await this.resolveDns(hostname);
                    if (ip) {
                        cb(null, ip, 4);
                    } else {
                        import('dns')
                            .then(({ lookup: dnsLookup }) => {
                                dnsLookup(hostname, options, cb);
                            })
                            .catch((err) => {
                                cb(err, '', 4);
                            });
                    }
                } catch (e) {
                    cb(e as Error, '', 4);
                }
            },
        });
    }

    /**
     * Rotate to the next configured RPC endpoint and rebuild the shared
     * Connection. Called when the active endpoint returns a rate-limit (429) so
     * the critical sell/stop-loss path fails over instead of hammering one
     * provider (proposal solana-stoploss-retry, requirement 2).
     */
    private rotateRpcConnection(): void {
        if (this.rpcPool.size <= 1) {
            this.logger.warn(
                '[RPC] Rate-limited but only one endpoint is configured; cannot fail over. ' +
                    'Set SOLANA_RPC_FALLBACKS to add backup providers.',
            );
            return;
        }
        const next = this.rpcPool.rotate();
        this.connection = new Connection(next, 'confirmed');
        this.logger.warn(`[RPC] Rate-limited — failed over to next endpoint (index rotated).`);
    }

    private get reportingService(): ReportingService {
        return this.moduleRef.get(ReportingService, { strict: false });
    }

    private async getWallet(chatId: string): Promise<Keypair> {
        if (!chatId) {
            throw new Error('Chat ID is required for live wallet operations.');
        }

        return this.telegramWorkspace.getWalletKeypair(chatId);
    }

    async onModuleInit() {
        if (this.connection) {
            try {
                const connectedWallets = await this.telegramWorkspace.getConnectedWalletCount();
                this.logger.log(
                    `[Init] Chat-generated wallet mode active. Connected wallets: ${connectedWallets}`,
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(`Failed to initialize chat wallet mode: ${message}`);
                throw error;
            }

            // 🚀 JITO TIP ACCOUNTS: Fetch Jito tip accounts on startup
            await this.refreshJitoTipAccounts();

            // 🔁 IDEMPOTENCY: rehydrate pending-sell signatures from disk BEFORE
            // resuming monitoring, so a sell tx that was broadcast-but-unconfirmed
            // when the process died is reconciled on-chain (not blind re-sold) on
            // the first resumed tick (finding: idempotency state was process-local).
            this.pendingSellSignatures.load();

            // 🚀 RESUME MONITORING: Pantau lagi koin yang masih nyangkut/open
            await this.startMonitoringAllTrades();
            await this.preloadOpenTradeDecimals();
        }
    }

    private async refreshJitoTipAccounts() {
        const useJito = this.configService.get<string>('USE_JITO') === 'true';
        if (!useJito) return;

        const jitoBlockEngineUrl =
            this.configService.get<string>('JITO_BLOCK_ENGINE_URL') ||
            'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

        try {
            const response = await axios.post(
                jitoBlockEngineUrl,
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getTipAccounts',
                    params: [],
                },
                {
                    headers: { 'Content-Type': 'application/json' },
                    httpsAgent: this.httpsAgent,
                    timeout: 5000,
                },
            );

            if (
                response.data?.result &&
                Array.isArray(response.data.result) &&
                response.data.result.length > 0
            ) {
                this.jitoTipAccounts = response.data.result as string[];
                this.logger.log(
                    `[Jito] Successfully loaded ${this.jitoTipAccounts.length} tip accounts dynamically.`,
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[Jito] Failed to fetch tip accounts dynamically: ${message}`);
        }
    }

    private async getJitoTipAccount(): Promise<string> {
        if (this.jitoTipAccounts.length === 0) {
            await this.refreshJitoTipAccounts();
        }
        if (this.jitoTipAccounts.length === 0) {
            throw new Error('No Jito tip accounts available from block engine API');
        }
        return this.jitoTipAccounts[Math.floor(Math.random() * this.jitoTipAccounts.length)];
    }

    private async startMonitoringAllTrades() {
        const openTrades = await this.prismaService.trade.count({
            where: { status: 'OPEN', mode: 'LIVE' },
        });

        this.logger.log(
            `[Monitor] Found ${openTrades} open positions. PriceMonitorService will handle tracking.`,
        );
    }

    private async preloadOpenTradeDecimals() {
        const openTrades = await this.prismaService.trade.findMany({
            where: { status: 'OPEN', mode: 'LIVE' },
            select: { tokenMint: true },
        });

        for (const trade of openTrades) {
            try {
                await this.getTokenDecimalsStrict(trade.tokenMint);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.warn(`[Decimals] Could not preload ${trade.tokenMint}: ${msg}`);
            }
        }
    }

    private async updateTradeAuditFields(
        tradeId: number,
        fields: Required<TradeAuditFields>,
    ): Promise<void> {
        await this.prismaService.$executeRaw`
            UPDATE "Trade"
            SET "solPriceAtEntry" = ${fields.solPriceAtEntry},
                "entryValueUsd" = ${fields.entryValueUsd},
                "totalFeesSol" = ${fields.totalFeesSol}
            WHERE "id" = ${tradeId}
        `;
    }

    private async incrementTradeFees(tradeId: number, totalFeesSol: number): Promise<void> {
        await this.prismaService.$executeRaw`
            UPDATE "Trade"
            SET "totalFeesSol" = COALESCE("totalFeesSol", 0) + ${totalFeesSol}
            WHERE "id" = ${tradeId}
        `;
    }

    // profitUsd is Float? with no @default and no migration to backfill one, so a Prisma
    // atomic `increment` (NULL + x = NULL in SQL) permanently leaves it NULL for every
    // trade's first sell. Mirrors the incrementTradeFees COALESCE pattern above.
    private async incrementTradeProfit(tradeId: number, profitUsd: number): Promise<void> {
        await this.prismaService.$executeRaw`
            UPDATE "Trade"
            SET "profitUsd" = COALESCE("profitUsd", 0) + ${profitUsd}
            WHERE "id" = ${tradeId}
        `;
    }

    private async getTradeAuditFields(tradeId: number): Promise<TradeAuditFields> {
        const rows = await this.prismaService.$queryRaw<TradeAuditFields[]>`
            SELECT "solPriceAtEntry", "entryValueUsd", "totalFeesSol"
            FROM "Trade"
            WHERE "id" = ${tradeId}
            LIMIT 1
        `;
        return rows[0] || {};
    }

    private sanitizeSizeMultiplier(value: number | undefined, fallback = 1): number {
        return sanitizeBuySizeMultiplier(value, fallback);
    }

    private getRouteSizeMultiplier(route?: TradeRoute): number {
        if (route === 'MICIN') {
            return this.sanitizeSizeMultiplier(this.micinPositionSizeMultiplier);
        }
        if (route === 'WHALE') {
            return this.sanitizeSizeMultiplier(this.whalePositionSizeMultiplier);
        }
        return 1;
    }

    private applyFinalSize(baseSizeUsd: number, route?: TradeRoute, aiMultiplier?: number): number {
        const routeMultiplier = this.getRouteSizeMultiplier(route);
        return calculateFinalBuySizeUsd(baseSizeUsd, routeMultiplier, aiMultiplier);
    }

    private getNumberConfig(key: string, fallback: number): number {
        const value = Number.parseFloat(this.configService.get<string>(key, String(fallback)));
        return Number.isFinite(value) ? value : fallback;
    }

    private isWithdrawEnabled(): boolean {
        return isWithdrawalsEnabled(this.configService.get<string>('WITHDRAWALS_ENABLED'));
    }

    private getWithdrawAllowedChatIds(): string[] {
        return parseChatIdList(this.configService.get<string>('WITHDRAW_ALLOWED_CHAT_IDS') || '');
    }

    private denyWithdraw(
        chatId: string,
        reason: WithdrawGuardReason,
    ): { success: false; message: string } {
        this.logger.warn(
            `[WithdrawGuard] Blocked withdraw attempt chat=${chatId} reason=${reason}`,
        );
        const message =
            reason === 'withdrawals_disabled'
                ? 'Withdrawals are disabled.'
                : reason === 'chat_not_allowed'
                  ? 'This Telegram chat is not allowed to withdraw.'
                  : reason === 'wallet_not_connected'
                    ? 'Wallet is not connected for this Telegram chat.'
                    : 'Wallet ownership validation failed for this Telegram chat.';
        return { success: false, message };
    }

    private calculateDynamicReserveUsd(balanceUsd: number): number {
        const reserveRatio = Math.min(
            Math.max(this.getNumberConfig('DYNAMIC_RESERVE_RATIO', 0.2), 0),
            0.95,
        );
        const minReserveUsd = Math.max(this.getNumberConfig('MIN_RESERVE_USD', 1), 0);
        const maxReserveUsd = Math.max(this.getNumberConfig('MAX_RESERVE_USD', 10), minReserveUsd);
        const percentageReserve = balanceUsd * reserveRatio;
        const configuredReserve = Math.max(
            Number.isFinite(this.reserveAmount) ? this.reserveAmount : 0,
            minReserveUsd,
        );
        return Math.min(Math.max(percentageReserve, configuredReserve), maxReserveUsd);
    }

    private getRouteMaxSlippageBps(route?: TradeRoute): number {
        if (route === 'MICIN') {
            return this.getNumberConfig('MICIN_MAX_SLIPPAGE_BPS', 300);
        }
        if (route === 'WHALE') {
            return this.getNumberConfig('WHALE_MAX_SLIPPAGE_BPS', 150);
        }
        return this.getNumberConfig('SLIPPAGE_BPS', this.slippageBps);
    }

    private getRouteMaxPriceImpactPct(route?: TradeRoute): number {
        if (route === 'MICIN') {
            return this.getNumberConfig('MICIN_MAX_PRICE_IMPACT_PCT', 2.5);
        }
        if (route === 'WHALE') {
            return this.getNumberConfig('WHALE_MAX_PRICE_IMPACT_PCT', 1.0);
        }
        return this.getNumberConfig('MAX_PRICE_IMPACT_PCT', 10);
    }

    private getBooleanConfig(key: string, fallback: boolean): boolean {
        const raw = this.configService.get<string | boolean>(key, fallback);
        if (typeof raw === 'boolean') return raw;
        const normalized = String(raw).trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
        return fallback;
    }

    private getRouteMaxRoundtripLossPct(route?: TradeRoute): number {
        if (route === 'MICIN') {
            return this.getNumberConfig('MICIN_MAX_PREBUY_ROUNDTRIP_LOSS_PCT', 15);
        }
        if (route === 'WHALE') {
            return this.getNumberConfig('WHALE_MAX_PREBUY_ROUNDTRIP_LOSS_PCT', 10);
        }
        return this.getNumberConfig('MAX_PREBUY_ROUNDTRIP_LOSS_PCT', 12);
    }
    private getStartOfDayUtc(): Date {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        return d;
    }

    private async getBuyRiskMetrics(
        maxConsecutiveLosses: number,
        route?: TradeRoute,
        riskPnlStartAt?: Date | null,
        consecutiveLookbackHours = 3,
        telegramChatDbId?: number,
    ): Promise<BuyRiskMetrics> {
        const dayStart = this.getStartOfDayUtc();
        const effectiveDailyStart =
            riskPnlStartAt && riskPnlStartAt.getTime() > dayStart.getTime()
                ? riskPnlStartAt
                : dayStart;
        const chatWhere = telegramChatDbId ? { telegramChatId: telegramChatDbId } : {};
        const baseWhere = riskPnlStartAt
            ? {
                  status: 'CLOSED' as const,
                  mode: 'LIVE' as const,
                  updatedAt: { gte: riskPnlStartAt },
                  ...chatWhere,
              }
            : { status: 'CLOSED' as const, mode: 'LIVE' as const, ...chatWhere };
        const consecutiveStartAt = resolveRiskLookbackStart(
            riskPnlStartAt,
            consecutiveLookbackHours,
        );
        const consecutiveWhere = consecutiveStartAt
            ? {
                  status: 'CLOSED' as const,
                  mode: 'LIVE' as const,
                  updatedAt: { gte: consecutiveStartAt },
                  ...chatWhere,
              }
            : { status: 'CLOSED' as const, mode: 'LIVE' as const, ...chatWhere };
        const routeWhere = route ? { route } : {};

        const feeSelect = { profitUsd: true, totalFeesSol: true, solPriceAtEntry: true } as const;
        const [dailyRows, totalRows, recentClosed] = await Promise.all([
            this.prismaService.trade.findMany({
                where: {
                    status: 'CLOSED',
                    mode: 'LIVE',
                    updatedAt: { gte: effectiveDailyStart },
                    ...chatWhere,
                },
                select: feeSelect,
            }),
            this.prismaService.trade.findMany({ where: baseWhere, select: feeSelect }),
            maxConsecutiveLosses > 0
                ? this.prismaService.trade.findMany({
                      where: { ...consecutiveWhere, ...routeWhere },
                      orderBy: { updatedAt: 'desc' },
                      take: Math.min(maxConsecutiveLosses, 50),
                      select: feeSelect,
                  })
                : Promise.resolve(
                      [] as Array<{
                          profitUsd: number | null;
                          totalFeesSol: number | null;
                          solPriceAtEntry: number | null;
                      }>,
                  ),
        ]);

        // Net-of-fees: a gross win that is a net loss must count as a loss for the breakers.
        const dailyRealizedPnlUsd = dailyRows.reduce((s, t) => s + computeNetProfitUsd(t), 0);
        const totalRealizedPnlUsd = totalRows.reduce((s, t) => s + computeNetProfitUsd(t), 0);

        let consecutiveLosses = 0;
        if (maxConsecutiveLosses > 0) {
            for (const t of recentClosed) {
                if (computeNetProfitUsd(t) < 0) consecutiveLosses++;
                else break;
            }
        }

        return { dailyRealizedPnlUsd, consecutiveLosses, totalRealizedPnlUsd };
    }

    /**
     * Helper to resolve DNS using Google DNS-over-HTTPS if standard lookup fails
     */
    private getRiskPnlStartAt(): Date | null {
        const raw = (this.configService.get<string>('RISK_PNL_START_AT', '') || '').trim();
        if (!raw) return null;

        const parsedMs = Date.parse(raw);
        if (!Number.isFinite(parsedMs)) {
            this.logger.warn(
                `[Risk] Ignoring invalid RISK_PNL_START_AT="${raw}". Use an ISO timestamp.`,
            );
            return null;
        }

        return new Date(parsedMs);
    }

    private async resolveDns(hostname: string): Promise<string | null> {
        if (this.ipCache[hostname]) return this.ipCache[hostname];

        try {
            this.logger.log(`[DNS] Resolving ${hostname} via Cloudflare/Google DoH...`);
            // Try Cloudflare first
            let response = await axios
                .get(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
                    headers: { accept: 'application/dns-json' },
                    timeout: 5000,
                    httpsAgent: new https.Agent({ family: 4 }),
                })
                .catch(() => null);

            // If Cloudflare fails, try Google
            if (!response) {
                response = await axios
                    .get(`https://8.8.8.8/resolve?name=${hostname}&type=A`, {
                        timeout: 5000,
                        httpsAgent: new https.Agent({ family: 4 }),
                    })
                    .catch(() => null);
            }

            const ip = response?.data?.Answer?.[0]?.data;
            if (ip && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
                this.logger.log(`[DNS] Resolved ${hostname} to ${ip}`);
                this.ipCache[hostname] = ip;
                return ip;
            }
        } catch {
            // Silence DNS errors
        }

        const fallbackIp = this.fallbackApiIps[hostname];
        if (fallbackIp) {
            this.logger.warn(
                `[DNS] Falling back to temporary pinned IP for ${hostname}: ${fallbackIp}`,
            );
            return fallbackIp;
        }

        return null;
    }

    private async saveTokenSafetyProbe(params: {
        telegramChatId: number;
        tokenMint: string;
        walletAddress: string;
        amountUsd: number;
        verdict: 'PASSED' | 'BLOCKED' | 'INCONCLUSIVE';
        reason?: string;
        buyTxHash?: string;
        sellTxHash?: string;
    }): Promise<void> {
        const cacheHours = Math.max(0, this.getNumberConfig('HONEYPOT_PROBE_CACHE_HOURS', 24));
        const expiresAt =
            params.verdict === 'PASSED' ? new Date(Date.now() + cacheHours * 60 * 60 * 1000) : null;
        await this.prismaService.tokenSafetyProbe.upsert({
            where: {
                telegramChatId_tokenMint: {
                    telegramChatId: params.telegramChatId,
                    tokenMint: params.tokenMint,
                },
            },
            update: {
                walletAddress: params.walletAddress,
                amountUsd: params.amountUsd,
                verdict: params.verdict,
                reason: params.reason,
                buyTxHash: params.buyTxHash,
                sellTxHash: params.sellTxHash,
                expiresAt,
            },
            create: {
                telegramChatId: params.telegramChatId,
                tokenMint: params.tokenMint,
                walletAddress: params.walletAddress,
                amountUsd: params.amountUsd,
                verdict: params.verdict,
                reason: params.reason,
                buyTxHash: params.buyTxHash,
                sellTxHash: params.sellTxHash,
                expiresAt,
            },
        });
    }

    private isDefinitiveProbeSellFailure(error?: string): boolean {
        if (!error) return false;
        const normalized = error.toLowerCase();
        return (
            normalized.startsWith('swap_failed:') ||
            normalized.includes('no route') ||
            normalized.includes('route not found') ||
            normalized.includes('token is frozen') ||
            normalized.includes('non-transferable') ||
            normalized.includes('custom program error')
        );
    }

    private async waitForProbeTokenBalance(
        walletAddress: string,
        tokenMint: string,
        isExpectedBalance: (balance: number) => boolean,
        attempts = 4,
    ): Promise<number | null> {
        let lastBalance: number | null = null;
        for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
            lastBalance = await this.getTokenBalance(walletAddress, tokenMint);
            if (lastBalance !== null && isExpectedBalance(lastBalance)) {
                return lastBalance;
            }
            if (attempt < attempts) {
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
        return lastBalance;
    }

    private async runConditionalHoneypotProbe(params: {
        telegramChatDbId: number;
        tokenMint: string;
        wallet: Keypair;
        positionUsd: number;
        solPrice: number;
        slippageBps: number;
        route?: TradeRoute;
    }): Promise<{ passed: boolean; attempted: boolean; reason?: string }> {
        const enabled = this.getBooleanConfig('ENABLE_HONEYPOT_LIVE_PROBE', true);
        const minimumPositionUsd = Math.max(
            0,
            this.getNumberConfig('HONEYPOT_PROBE_MIN_POSITION_USD', 20),
        );
        if (!enabled || params.positionUsd < minimumPositionUsd) {
            return { passed: true, attempted: false };
        }

        const walletAddress = params.wallet.publicKey.toBase58();
        const blockedProbe = await this.prismaService.tokenSafetyProbe.findFirst({
            where: { tokenMint: params.tokenMint, verdict: 'BLOCKED' },
            select: { reason: true },
        });
        if (blockedProbe) {
            return {
                passed: false,
                attempted: false,
                reason: blockedProbe.reason || 'honeypot_probe_blocked',
            };
        }

        const cachedProbe = await this.prismaService.tokenSafetyProbe.findUnique({
            where: {
                telegramChatId_tokenMint: {
                    telegramChatId: params.telegramChatDbId,
                    tokenMint: params.tokenMint,
                },
            },
        });
        if (
            cachedProbe?.verdict === 'PASSED' &&
            cachedProbe.walletAddress === walletAddress &&
            cachedProbe.expiresAt &&
            cachedProbe.expiresAt.getTime() > Date.now()
        ) {
            return { passed: true, attempted: false };
        }

        const dustThreshold = Math.max(0, this.getNumberConfig('TRADE_DUST_THRESHOLD', 0.000001));
        const balanceBefore = await this.getTokenBalance(walletAddress, params.tokenMint);
        if (balanceBefore === null || balanceBefore > dustThreshold) {
            const reason =
                balanceBefore === null ? 'probe_balance_unavailable' : 'probe_existing_balance';
            await this.saveTokenSafetyProbe({
                telegramChatId: params.telegramChatDbId,
                tokenMint: params.tokenMint,
                walletAddress,
                amountUsd: 0,
                verdict: 'INCONCLUSIVE',
                reason,
            });
            return { passed: false, attempted: false, reason };
        }

        const probeUsd = Math.max(0.01, this.getNumberConfig('HONEYPOT_PROBE_USD', 0.5));
        const probeLamports = Math.floor((probeUsd / params.solPrice) * 1_000_000_000);
        const buyResult = await this.executeJupiterSwap(
            WRAPPED_SOL_MINT,
            params.tokenMint,
            probeLamports,
            'BUY',
            probeUsd,
            0,
            params.slippageBps,
            undefined,
            params.wallet,
            false,
            params.route,
        );

        let buyLanded = buyResult.success;
        if (
            !buyLanded &&
            buyResult.error?.startsWith('post_broadcast_unconfirmed') &&
            buyResult.txHash
        ) {
            const reconciledBuy = await this.getActualSwapDetails(
                buyResult.txHash,
                walletAddress,
                params.tokenMint,
                buyResult.jitoTipLamports ?? 0,
                'BUY',
            );
            buyLanded = Boolean(reconciledBuy && reconciledBuy.tokenChange > 0);
        }
        if (!buyLanded) {
            const reason = `probe_buy_inconclusive:${buyResult.error || 'unknown'}`;
            await this.saveTokenSafetyProbe({
                telegramChatId: params.telegramChatDbId,
                tokenMint: params.tokenMint,
                walletAddress,
                amountUsd: probeUsd,
                verdict: 'INCONCLUSIVE',
                reason,
                buyTxHash: buyResult.txHash,
            });
            return { passed: false, attempted: true, reason };
        }

        const tokenBalance = await this.waitForProbeTokenBalance(
            walletAddress,
            params.tokenMint,
            (balance) => balance > dustThreshold,
        );
        if (tokenBalance === null || tokenBalance <= dustThreshold) {
            const reason = 'probe_buy_balance_missing';
            await this.saveTokenSafetyProbe({
                telegramChatId: params.telegramChatDbId,
                tokenMint: params.tokenMint,
                walletAddress,
                amountUsd: probeUsd,
                verdict: 'INCONCLUSIVE',
                reason,
                buyTxHash: buyResult.txHash,
            });
            return { passed: false, attempted: true, reason };
        }

        const decimals = await this.getTokenDecimalsStrict(params.tokenMint);
        const sellAmount = Math.floor(tokenBalance * Math.pow(10, decimals));
        const sellResult = await this.executeJupiterSwap(
            params.tokenMint,
            WRAPPED_SOL_MINT,
            sellAmount,
            'SELL',
            probeUsd,
            0,
            params.slippageBps,
            undefined,
            params.wallet,
            false,
            params.route,
        );

        let sellLanded = sellResult.success;
        if (
            !sellLanded &&
            sellResult.error?.startsWith('post_broadcast_unconfirmed') &&
            sellResult.txHash
        ) {
            const reconciledSell = await this.getActualSwapDetails(
                sellResult.txHash,
                walletAddress,
                params.tokenMint,
                sellResult.jitoTipLamports ?? 0,
                'SELL',
            );
            sellLanded = Boolean(reconciledSell && reconciledSell.tokenChange < 0);
        }

        const balanceAfter = await this.waitForProbeTokenBalance(
            walletAddress,
            params.tokenMint,
            (balance) => balance <= dustThreshold,
        );
        if (sellLanded && balanceAfter !== null && balanceAfter <= dustThreshold) {
            await this.saveTokenSafetyProbe({
                telegramChatId: params.telegramChatDbId,
                tokenMint: params.tokenMint,
                walletAddress,
                amountUsd: probeUsd,
                verdict: 'PASSED',
                reason: 'probe_buy_sell_confirmed',
                buyTxHash: buyResult.txHash,
                sellTxHash: sellResult.txHash,
            });
            return { passed: true, attempted: true };
        }

        const definitiveFailure =
            this.isDefinitiveProbeSellFailure(sellResult.error) ||
            (sellLanded && balanceAfter !== null && balanceAfter > dustThreshold);
        const reason = definitiveFailure
            ? `honeypot_probe_sell_failed:${sellResult.error || 'token_balance_remains'}`
            : `probe_sell_inconclusive:${sellResult.error || 'balance_unavailable'}`;
        await this.saveTokenSafetyProbe({
            telegramChatId: params.telegramChatDbId,
            tokenMint: params.tokenMint,
            walletAddress,
            amountUsd: probeUsd,
            verdict: definitiveFailure ? 'BLOCKED' : 'INCONCLUSIVE',
            reason,
            buyTxHash: buyResult.txHash,
            sellTxHash: sellResult.txHash,
        });
        return { passed: false, attempted: true, reason };
    }

    async attemptBuy(
        tokenMint: string,
        metadata?: TokenMetadata,
        customAmountUSD?: number,
        options?: BuyExecutionOptions,
        telegramChatId?: string,
    ): Promise<{ success: boolean; message: string }> {
        if (!telegramChatId) {
            return { success: false, message: 'Live trading requires a registered Telegram chat.' };
        }

        const chatRecord = telegramChatId
            ? await this.telegramWorkspace.getChatById(telegramChatId)
            : null;
        if (!chatRecord) {
            return { success: false, message: 'Telegram chat not registered. Send /start first.' };
        }

        const chatSettings = telegramChatId
            ? await this.telegramWorkspace.getChatSettings(telegramChatId)
            : null;
        const isManualBuy = customAmountUSD !== undefined;
        const effectiveDryRun = isManualBuy ? false : (chatSettings?.dryRun ?? true);
        const effectiveTotalSlots = chatSettings?.totalSlots ?? this.totalSlots;
        const effectivePositionSizeUSD = chatSettings?.positionSizeUsd ?? this.positionSizeUSD;
        const requestedSlippageBps =
            options?.customSlippageBps ??
            (chatSettings
                ? Math.max(1, Math.round(chatSettings.slippageOnSol * 10000))
                : this.slippageBps);
        const wallet = await this.getWallet(telegramChatId);
        const tradeChatDbId = chatRecord?.id;
        const targetChatId = chatRecord?.chatId;
        const reportSymbol = metadata?.symbol || 'UNKNOWN';
        const route = options?.route ?? metadata?.route;
        const routeMaxSlippageBps = this.getRouteMaxSlippageBps(route);
        const selectedSlippageBps = capSlippageBps(requestedSlippageBps, routeMaxSlippageBps);
        const aiPositionSizeMultiplier =
            options?.positionSizeMultiplier ?? metadata?.positionSizeMultiplier;
        const aiDecisionSnapshotId =
            options?.aiDecisionSnapshotId ?? metadata?.aiDecisionSnapshotId;

        this.logger.log(
            `[BuyTrace] token=${tokenMint} chat=${telegramChatId} manual=${isManualBuy} dryRun=${effectiveDryRun} route=${route ?? 'GLOBAL'} slots=${effectiveTotalSlots} basePositionSizeUsd=${effectivePositionSizeUSD.toFixed(2)} requestedSlippageBps=${requestedSlippageBps} selectedSlippageBps=${selectedSlippageBps}`,
        );
        if (selectedSlippageBps < requestedSlippageBps) {
            this.logger.warn(
                `[BuyTrace] SLIPPAGE_CAPPED token=${tokenMint} route=${route ?? 'GLOBAL'} requestedSlippageBps=${requestedSlippageBps} selectedSlippageBps=${selectedSlippageBps}`,
            );
        }
        const notifyBuyFailure = async (params: {
            reason: string;
            stage?: 'PRE_SWAP' | 'QUOTE' | 'SWAP' | 'CONFIRMATION';
            amountUsd?: number;
            amountSol?: number;
            details?: string;
        }) => {
            if (!targetChatId) return;
            try {
                const normalizedReason = normalizeBuyFailureReason(
                    params.reason || params.details || 'unknown_execution_failure',
                );
                const normalizedStage = params.stage || normalizeBuyFailureStage(normalizedReason);

                await this.reportingService.sendTradeFailureAlert({
                    side: 'BUY',
                    tokenMint,
                    symbol: reportSymbol,
                    reason: normalizedReason,
                    stage: normalizedStage,
                    amountUsd: params.amountUsd,
                    amountSol: params.amountSol,
                    targetChatId,
                    route,
                    details: params.details,
                });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `[BuyTrace] Failed to send buy failure alert token=${tokenMint} chat=${telegramChatId}: ${msg}`,
                );
            }
        };

        const openTrades = await this.prismaService.trade.findMany({
            where: {
                status: 'OPEN',
                mode: 'LIVE',
                ...(tradeChatDbId ? { telegramChatId: tradeChatDbId } : {}),
            },
            select: {
                id: true,
                tokenMint: true,
                slotNumber: true,
                entryPrice: true,
                amountInSol: true,
                entryValueUsd: true,
                solPriceAtEntry: true,
                highestPrice: true,
                trailingStopPrice: true,
                totalFeesSol: true,
                symbol: true,
                buyTxHash: true,
                route: true,
                aiDecisionSnapshotId: true,
                entryLiquidity: true,
                entryPairAddress: true,
                entryMarketCap: true,
                creatorAddress: true,
                topHolderAddress: true,
                initialCreatorBalance: true,
                initialTopHolderBalance: true,
                targetTakeProfit: true,
                targetStopLoss: true,
                targetTrailingDistance: true,
                telegramChatId: true,
            },
        });
        const existingOpenTrade = openTrades.find((trade) => trade.tokenMint === tokenMint) ?? null;
        const recentTrade = await this.prismaService.trade.findFirst({
            where: {
                tokenMint,
                mode: 'LIVE',
                ...(tradeChatDbId ? { telegramChatId: tradeChatDbId } : {}),
            },
            orderBy: { createdAt: 'desc' },
        });

        if (recentTrade && !customAmountUSD && !existingOpenTrade) {
            // Jika manual buy (ada customAmount), abaikan cooldown
            if (recentTrade.status === 'OPEN') {
                this.logger.warn(
                    `[BuyTrace] Blocked by already-open trade token=${tokenMint} chat=${telegramChatId}`,
                );
                await notifyBuyFailure({
                    reason: 'already_open_trade',
                    details: `Already holding ${tokenMint}.`,
                });
                return { success: false, message: `Already holding ${tokenMint}` };
            }
            const winCooldownHours = Number.parseInt(
                this.configService.get<string>('COOLDOWN_WIN_HOURS', '6'),
                10,
            );
            const lossCooldownHours = Number.parseInt(
                this.configService.get<string>('COOLDOWN_LOSS_HOURS', '24'),
                10,
            );
            const isWin = (recentTrade.profitUsd || 0) > 0;
            const cooldownHours = isWin ? winCooldownHours : lossCooldownHours;
            const cooldownMillis = cooldownHours * 60 * 60 * 1000;
            const cooldownExpiredAt = recentTrade.updatedAt.getTime() + cooldownMillis;

            if (Date.now() < cooldownExpiredAt) {
                const msg = `Token ${tokenMint} is in cooldown until ${new Date(cooldownExpiredAt).toISOString()} (Last outcome: ${isWin ? 'WIN' : 'LOSS'}, Cooldown: ${cooldownHours}h). Skip.`;
                this.logger.warn(
                    `[BuyTrace] Blocked by cooldown token=${tokenMint} chat=${telegramChatId}: ${msg}`,
                );
                await notifyBuyFailure({
                    reason: 'cooldown',
                    details: msg,
                });
                return { success: false, message: msg };
            }
        }

        const openTradesCount = openTrades.length;
        if (openTradesCount >= effectiveTotalSlots && !existingOpenTrade) {
            this.logger.warn(
                `[BuyTrace] Blocked by slot limit token=${tokenMint} chat=${telegramChatId} openTrades=${openTradesCount} slots=${effectiveTotalSlots}`,
            );
            await notifyBuyFailure({
                reason: 'slot_guard',
                details: `Open trades: ${openTradesCount}, Slots: ${effectiveTotalSlots}.`,
            });
            return { success: false, message: 'All trading slots are full.' };
        }

        const usedSlots = new Set(openTrades.map((t) => t.slotNumber));
        let slotToUse = existingOpenTrade?.slotNumber ?? 1;
        if (!existingOpenTrade) {
            for (let i = 1; i <= effectiveTotalSlots; i++) {
                if (!usedSlots.has(i)) {
                    slotToUse = i;
                    break;
                }
            }
        }

        // Use custom amount if provided, otherwise use config
        const requestedBuyAmountUSD =
            customAmountUSD ??
            this.applyFinalSize(effectivePositionSizeUSD, route, aiPositionSizeMultiplier);
        let buyAmountUSD = Math.min(
            requestedBuyAmountUSD,
            Math.max(0, this.getNumberConfig('MAX_POSITION_USD', this.positionSizeUSD)),
        );
        // RISK CIRCUIT BREAKERS: block new buys on drawdown / daily loss / loss streak
        const riskApplyToManual =
            this.configService.get<string>('RISK_APPLY_TO_MANUAL', 'false') === 'true';
        const isManual = !!customAmountUSD;
        if (!isManual || riskApplyToManual) {
            const disabledUntilRaw = this.configService.get<string>('DISABLE_BUY_UNTIL') || '';
            const disabledUntilMs =
                disabledUntilRaw && !Number.isNaN(Date.parse(disabledUntilRaw))
                    ? Date.parse(disabledUntilRaw)
                    : null;

            const dailyMaxLossUsd = Number.parseFloat(
                this.configService.get<string>('DAILY_MAX_LOSS_USD', '0'),
            );
            const maxConsecutiveLosses = Number.parseInt(
                route === 'MICIN'
                    ? this.configService.get<string>(
                          'MICIN_MAX_CONSECUTIVE_LOSSES',
                          this.configService.get<string>('MAX_CONSECUTIVE_LOSSES', '0'),
                      )
                    : route === 'WHALE'
                      ? this.configService.get<string>(
                            'WHALE_MAX_CONSECUTIVE_LOSSES',
                            this.configService.get<string>('MAX_CONSECUTIVE_LOSSES', '0'),
                        )
                      : this.configService.get<string>('MAX_CONSECUTIVE_LOSSES', '0'),
                10,
            );
            const maxDrawdownPct = Number.parseFloat(
                this.configService.get<string>('MAX_DRAWDOWN_PCT', '0'),
            );

            const riskPnlStartAt = this.getRiskPnlStartAt();
            const consecutiveLookbackHours = Number.parseFloat(
                this.configService.get<string>('RISK_CONSECUTIVE_LOOKBACK_HOURS', '3'),
            );
            const effectiveConsecutiveLookbackHours = Number.isFinite(consecutiveLookbackHours)
                ? consecutiveLookbackHours
                : 3;
            const metrics = await this.getBuyRiskMetrics(
                maxConsecutiveLosses,
                route,
                riskPnlStartAt,
                effectiveConsecutiveLookbackHours,
                tradeChatDbId,
            );
            if (riskPnlStartAt || effectiveConsecutiveLookbackHours > 0) {
                const baselineText = riskPnlStartAt
                    ? `baseline=${riskPnlStartAt.toISOString()}`
                    : 'baseline=all_time';
                this.logger.log(
                    `[Risk] PnL risk window active (${baselineText}, consecutiveLookbackHours=${effectiveConsecutiveLookbackHours}). Older trades are ignored for applicable buy lockouts.`,
                );
            }
            const decision = evaluateBuyRisk(
                metrics,
                {
                    disabledUntilMs,
                    dailyMaxLossUsd: Number.isFinite(dailyMaxLossUsd) ? dailyMaxLossUsd : 0,
                    maxConsecutiveLosses: Number.isFinite(maxConsecutiveLosses)
                        ? maxConsecutiveLosses
                        : 0,
                    maxDrawdownPct: Number.isFinite(maxDrawdownPct) ? maxDrawdownPct : 0,
                },
                this.totalCapital,
            );

            if (!decision.allowed) {
                const msg =
                    `Risk breaker blocked buy (${decision.reason}). ` +
                    `route=${route ?? 'GLOBAL'}, ` +
                    `chat=${telegramChatId}, ` +
                    `dailyPnL=$${metrics.dailyRealizedPnlUsd.toFixed(2)}, ` +
                    `consecutiveLosses=${metrics.consecutiveLosses}, ` +
                    `totalPnL=$${metrics.totalRealizedPnlUsd.toFixed(2)}.`;
                this.logger.warn(`[Risk] ${msg}`);
                await notifyBuyFailure({
                    reason: `risk_${decision.reason}`,
                    details: msg,
                    amountUsd: buyAmountUSD,
                });
                return { success: false, message: msg };
            }
        }

        // Ambil harga SOL terbaru
        const solPrice = await this.getSolPrice();
        try {
            const sizingBalanceLamports = await this.connection.getBalance(wallet.publicKey);
            const sizingBalanceUsd = (sizingBalanceLamports / 1_000_000_000) * solPrice;
            const sizingReserveUsd = this.calculateDynamicReserveUsd(sizingBalanceUsd);
            const spendableAfterReserveUsd = Math.max(sizingBalanceUsd - sizingReserveUsd, 0);
            const maxPositionUsd = Math.max(
                0,
                this.getNumberConfig('MAX_POSITION_USD', this.positionSizeUSD),
            );
            const maxWalletPct = Math.min(
                Math.max(this.getNumberConfig('MAX_POSITION_WALLET_PCT', 100), 0),
                100,
            );
            const walletPositionCapUsd = spendableAfterReserveUsd * (maxWalletPct / 100);
            buyAmountUSD = capBuyPositionUsd(
                requestedBuyAmountUSD,
                maxPositionUsd,
                spendableAfterReserveUsd,
                maxWalletPct,
            );
            this.logger.log(
                `[BuyTrace] PositionCap token=${tokenMint} chat=${telegramChatId} requestedUsd=${requestedBuyAmountUSD.toFixed(2)} maxUsd=${maxPositionUsd.toFixed(2)} walletCapUsd=${walletPositionCapUsd.toFixed(2)} finalUsd=${buyAmountUSD.toFixed(2)}`,
            );
            if (!Number.isFinite(buyAmountUSD) || buyAmountUSD <= 0) {
                const msg = 'Capital guard blocked buy. No spendable balance after reserve.';
                await notifyBuyFailure({ reason: 'capital_guard', details: msg, amountUsd: 0 });
                return { success: false, message: msg };
            }

            const minimumExecutableUsd = calculateMinimumExecutablePositionUsd(
                this.getNumberConfig('MIN_EXECUTABLE_POSITION_USD', 3.5),
                this.getNumberConfig('ESTIMATED_ROUNDTRIP_FEE_SOL', 0.0013),
                solPrice,
                this.getNumberConfig('MAX_ESTIMATED_ROUNDTRIP_FEE_PCT', 3),
            );
            if (buyAmountUSD < minimumExecutableUsd) {
                const msg =
                    `Fee floor blocked buy. Capped position=${buyAmountUSD.toFixed(2)}, ` +
                    `minimum=${minimumExecutableUsd.toFixed(2)} based on estimated round-trip fees.`;
                this.logger.warn(
                    `[BuyTrace] FEE_FLOOR token=${tokenMint} chat=${telegramChatId} ${msg}`,
                );
                await notifyBuyFailure({
                    reason: 'fee_floor_guard',
                    details: msg,
                    amountUsd: buyAmountUSD,
                });
                return { success: false, message: msg };
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await notifyBuyFailure({ reason: 'capital_guard', details: msg });
            return { success: false, message: `Position sizing failed: ${msg}` };
        }
        const amountInSol = buyAmountUSD / solPrice;
        const amountInLamports = Math.floor(amountInSol * 1_000_000_000);
        const priorityFeeLamports = options?.priorityFeeSol
            ? Math.floor(options.priorityFeeSol * 1_000_000_000)
            : undefined;
        const executionPayload: TradeExecutionPayload = {
            tokenMint,
            amountSol: amountInSol,
            slippage: selectedSlippageBps,
            priorityFee: priorityFeeLamports || 0,
            skipPreflight: false,
        };

        try {
            if (
                !Number.isFinite(solPrice) ||
                solPrice <= 0 ||
                !Number.isFinite(executionPayload.amountSol) ||
                executionPayload.amountSol <= 0
            ) {
                this.logger.warn(
                    `[BuyTrace] Blocked by invalid price/amount token=${tokenMint} chat=${telegramChatId} solPrice=${solPrice} amountSol=${executionPayload.amountSol}`,
                );
                await notifyBuyFailure({
                    reason: 'invalid_price_or_amount',
                    details: `SOL price=${solPrice}, amountSol=${executionPayload.amountSol}.`,
                    amountUsd: buyAmountUSD,
                    amountSol: executionPayload.amountSol,
                });
                return {
                    success: false,
                    message: 'Capital guard blocked buy. Invalid SOL price or buy amount.',
                };
            }

            const wallet = await this.getWallet(telegramChatId);
            const balanceLamports = await this.connection.getBalance(wallet.publicKey);
            const balanceSol = balanceLamports / 1_000_000_000;
            const balanceUsd = balanceSol * solPrice;
            const dynamicReserveUsd = this.calculateDynamicReserveUsd(balanceUsd);
            const reserveSol = dynamicReserveUsd / solPrice;
            const feeCushionSol = this.getNumberConfig('TRADE_FEE_CUSHION_SOL', 0.005);
            const totalRequiredSol = executionPayload.amountSol + reserveSol + feeCushionSol;
            const balanceAfterBuy = balanceSol - executionPayload.amountSol;
            const balanceAfterBuyUsd = balanceAfterBuy * solPrice;
            const openExposureUsd = openTrades.reduce((sum, trade) => {
                const value = Number(trade.entryValueUsd);
                return (
                    sum + (Number.isFinite(value) && value > 0 ? value : effectivePositionSizeUSD)
                );
            }, 0);
            const committedCapitalUsd = openExposureUsd + buyAmountUSD;
            const spendableCapitalUsd = Math.max(balanceUsd - dynamicReserveUsd, 0);
            this.logger.log(
                `[BuyTrace] GuardContext token=${tokenMint} route=${route ?? 'GLOBAL'} basePositionSizeUsd=${effectivePositionSizeUSD.toFixed(2)} routeMultiplier=${this.getRouteSizeMultiplier(route).toFixed(3)} aiMultiplier=${sanitizeBuySizeMultiplier(aiPositionSizeMultiplier).toFixed(3)} finalBuyUsd=${buyAmountUSD.toFixed(2)} balanceSol=${balanceSol.toFixed(6)} balanceUsd=${balanceUsd.toFixed(2)} dynamicReserveUsd=${dynamicReserveUsd.toFixed(2)} spendableCapitalUsd=${spendableCapitalUsd.toFixed(2)} openExposureUsd=${openExposureUsd.toFixed(2)} committedCapitalUsd=${committedCapitalUsd.toFixed(2)} requestedSlippageBps=${requestedSlippageBps} selectedSlippageBps=${selectedSlippageBps} maxPriceImpactPct=${this.getRouteMaxPriceImpactPct(route)} dryRun=${effectiveDryRun}`,
            );

            if (committedCapitalUsd > spendableCapitalUsd) {
                const msg = `Capital guard blocked buy. Wallet=$${balanceUsd.toFixed(2)}, Spendable=$${spendableCapitalUsd.toFixed(2)}, Reserve=$${dynamicReserveUsd.toFixed(2)}, CommittedAfterBuy=$${committedCapitalUsd.toFixed(2)}.`;
                this.logger.warn(
                    `[BuyTrace] Blocked by dynamic capital guard token=${tokenMint} chat=${telegramChatId} ${msg}`,
                );
                await notifyBuyFailure({
                    reason: 'capital_guard',
                    details: msg,
                    amountUsd: buyAmountUSD,
                });
                return { success: false, message: msg };
            }

            if (balanceAfterBuy < reserveSol || balanceSol < totalRequiredSol) {
                const msg = `Insufficient SOL balance. Have: ${balanceSol.toFixed(4)} SOL ($${balanceUsd.toFixed(2)}), Need: ${totalRequiredSol.toFixed(4)} SOL (Position: ${executionPayload.amountSol.toFixed(4)} SOL, Dynamic Reserve: ${reserveSol.toFixed(4)} SOL / $${dynamicReserveUsd.toFixed(2)} + Fee cushion ${feeCushionSol.toFixed(4)} SOL). Balance after buy would be $${balanceAfterBuyUsd.toFixed(2)}. Aborting buy before swap to prevent wasted fees.`;
                this.logger.warn(`[Slot ${slotToUse}] ${msg}`);
                this.logger.warn(
                    `[BuyTrace] Blocked by balance token=${tokenMint} chat=${telegramChatId} wallet=${wallet.publicKey.toBase58()} balanceSol=${balanceSol.toFixed(6)}`,
                );
                await notifyBuyFailure({
                    reason: 'balance_guard',
                    details: msg,
                    amountUsd: buyAmountUSD,
                    amountSol: executionPayload.amountSol,
                });
                return { success: false, message: msg };
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[Slot ${slotToUse}] Capital protection check failed: ${msg}`);
            this.logger.error(
                `[BuyTrace] Capital protection exception token=${tokenMint} chat=${telegramChatId}: ${msg}`,
            );
            await notifyBuyFailure({
                reason: 'capital_guard',
                details: msg,
                amountUsd: buyAmountUSD,
            });
            return {
                success: false,
                message: `Capital protection check failed: ${msg}`,
            };
        }

        let executionBuySignal = options;
        if (!isManualBuy && !effectiveDryRun && tradeChatDbId) {
            let probe: { passed: boolean; attempted: boolean; reason?: string };
            try {
                probe = await this.runConditionalHoneypotProbe({
                    telegramChatDbId: tradeChatDbId,
                    tokenMint,
                    wallet,
                    positionUsd: buyAmountUSD,
                    solPrice,
                    slippageBps: selectedSlippageBps,
                    route,
                });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                await notifyBuyFailure({
                    reason: 'honeypot_probe_error',
                    details: reason,
                    amountUsd: buyAmountUSD,
                });
                return { success: false, message: `honeypot_probe_error:${reason}` };
            }
            if (!probe.passed) {
                const reason = probe.reason || 'honeypot_probe_failed';
                await notifyBuyFailure({
                    reason: 'honeypot_probe_failed',
                    details: reason,
                    amountUsd: buyAmountUSD,
                });
                return { success: false, message: reason };
            }
            if (probe.attempted) {
                // The safety probe intentionally consumes time. Preserve the original
                // price-chase baseline while resetting only the signal age for main execution.
                executionBuySignal = { ...options, signalObservedAt: Date.now() };
            }
        }

        this.logger.log(
            `[Slot ${slotToUse}] Attempting to buy ${tokenMint} route=${route ?? 'GLOBAL'} with $${buyAmountUSD.toFixed(2)} (${amountInSol.toFixed(4)} SOL)`,
        );

        const buySwapResult = await this.executeJupiterSwap(
            WRAPPED_SOL_MINT,
            tokenMint,
            amountInLamports,
            'BUY',
            buyAmountUSD,
            0,
            selectedSlippageBps,
            priorityFeeLamports,
            wallet,
            effectiveDryRun,
            route,
            undefined,
            executionBuySignal,
        );

        // txHash and jitoTipLamports are read-only here; the rest are reassigned by the
        // idempotency recovery below, so they stay `let`.
        const { txHash, jitoTipLamports } = buySwapResult;
        let { success, entryPrice, error, actualSol, actualTokens, totalFeesSol } = buySwapResult;

        // IDEMPOTENCY RECOVERY (finding: the shared post-broadcast guard orphans BUYs).
        //
        // SCOPE DISCLOSURE: this block is a DELIBERATE behavior change on the BUY path,
        // outside the stop-loss/sell path the retry work targeted. It is NOT incidental
        // scope creep — it is MANDATED by the project rule in .claude/CLAUDE.md: "Any code
        // path that ... protects a live position MUST have ... an alert on final failure."
        // The sell-path idempotency fix made the SHARED executeJupiterSwap return
        // `post_broadcast_unconfirmed` for BUY too; without handling it here a BUY tx that
        // actually LANDED becomes an orphaned, unmonitored bag (tokens in the wallet with no
        // trade row -> no PriceMonitor, no stop-loss, no alert) — i.e. an unprotected open
        // position, exactly what that rule forbids. Leaving BUY unchanged would therefore
        // have INTRODUCED a rule violation, not preserved scope.
        //
        // executeJupiterSwap deliberately does NOT re-send after broadcast (a blind re-send
        // could double-execute). SELL is reconciled on the next tick via
        // pendingSellSignatures; a BUY has no tick loop, so reconcile the exact signature
        // on-chain HERE: if the buy landed, recover it into a monitored trade using the real
        // on-chain fill; otherwise fire a prominent alert so a possibly-open position is
        // never silently lost.
        if (
            !success &&
            !effectiveDryRun &&
            typeof error === 'string' &&
            error.startsWith('post_broadcast_unconfirmed') &&
            txHash
        ) {
            const reconciled = await this.getActualSwapDetails(
                txHash,
                wallet.publicKey.toBase58(),
                tokenMint,
                // Real Jito tip paid for THIS broadcast attempt (0 if Jito wasn't used),
                // returned by executeJupiterSwap above. Hardcoding 0 here would permanently
                // undercount totalFeesSol for any BUY that had to go through this recovery path.
                jitoTipLamports ?? 0,
                'BUY',
            );
            if (reconciled && Math.abs(reconciled.tokenChange) > 0) {
                const recTokens = Math.abs(reconciled.tokenChange);
                const recSol = reconciled.cleanSolAmount ?? Math.abs(reconciled.solChange);
                const recPrice = recTokens > 0 && solPrice ? (recSol * solPrice) / recTokens : 0;
                if (recPrice > 0) {
                    // The buy DID land — treat as success so the normal creation +
                    // monitoring path below registers it (PriceMonitor picks up the DB row).
                    success = true;
                    actualSol = recSol;
                    actualTokens = recTokens;
                    totalFeesSol = reconciled.totalFeesSol;
                    entryPrice = recPrice;
                    error = undefined;
                    this.logger.warn(
                        `[BuyTrace] Recovered UNCONFIRMED BUY via on-chain reconciliation ` +
                            `token=${tokenMint} chat=${telegramChatId} tx=${txHash} ` +
                            `tokens=${recTokens} solSpent=${recSol} entryPrice=${recPrice}. ` +
                            `Registering as a monitored trade.`,
                    );
                }
            }
            if (!success) {
                // Could not confirm the buy landed (still in-flight, or genuinely failed).
                // Never silently drop it — a tx that lands later would be unmonitored.
                this.logger.error(
                    `[BuyTrace] UNRECONCILED unconfirmed BUY token=${tokenMint} ` +
                        `chat=${telegramChatId} tx=${txHash}. If it lands it will be UNMONITORED.`,
                );
                try {
                    await this.reportingService.sendTradeFailureAlert({
                        side: 'BUY',
                        tokenMint,
                        stage: 'CONFIRMATION',
                        reason: `buy_broadcast_unconfirmed: ${error}`,
                        amountUsd: buyAmountUSD,
                        targetChatId,
                        details:
                            `BUY tx ${txHash} was broadcast but not confirmed and could not be ` +
                            `reconciled on-chain. If it lands, the position will be UNMONITORED ` +
                            `(no stop-loss). ACTIONABLE: check the signature and, if it landed, ` +
                            `import/monitor it manually.`,
                    });
                } catch (alertErr) {
                    const m = alertErr instanceof Error ? alertErr.message : String(alertErr);
                    this.logger.error(`[BuyTrace] Failed to send unconfirmed-BUY alert: ${m}`);
                }
            }
        }

        if (success && entryPrice > 0) {
            const finalAmountInSol = actualSol || amountInSol;
            const entryValueUsd = finalAmountInSol * solPrice;
            const entryPriceSol =
                actualTokens && actualTokens > 0
                    ? finalAmountInSol / actualTokens
                    : entryPrice / solPrice;
            const symbol = await this.fetchTokenSymbol(tokenMint);
            if (effectiveDryRun) {
                this.logger.log(
                    `[BuyTrace] Dry-run quote validated token=${tokenMint} chat=${telegramChatId} route=${route ?? 'GLOBAL'} finalBuyUsd=${buyAmountUSD.toFixed(2)} entryPrice=${entryPrice}`,
                );
                return {
                    success: true,
                    message: `[DRY_RUN] Quote validated. No live swap executed for ${symbol}.`,
                };
            }
            // Keep RPC failures distinct from a real zero balance. A failed lookup must not
            // disable the developer-dump watcher by being silently stored as 0.
            let initialCreatorBalance: number | null = null;
            let initialTopHolderBalance: number | null = null;

            if (metadata?.creator) {
                const bal = await this.getTokenBalance(metadata.creator, tokenMint);
                initialCreatorBalance =
                    typeof bal === 'number' && Number.isFinite(bal) ? bal : null;
            }
            if (metadata?.topHolder) {
                const bal = await this.getTokenBalance(metadata.topHolder, tokenMint);
                initialTopHolderBalance =
                    typeof bal === 'number' && Number.isFinite(bal) ? bal : null;
            }

            const mergedScaleIn = existingOpenTrade
                ? mergeTradeScaleInPosition({
                      existingAmountInSol: existingOpenTrade.amountInSol,
                      existingEntryPriceSol: existingOpenTrade.entryPrice,
                      existingEntryValueUsd: existingOpenTrade.entryValueUsd,
                      existingSolPriceAtEntry: existingOpenTrade.solPriceAtEntry,
                      existingHighestPriceSol: existingOpenTrade.highestPrice,
                      existingTotalFeesSol: existingOpenTrade.totalFeesSol,
                      fillAmountInSol: finalAmountInSol,
                      fillEntryPriceSol: entryPriceSol,
                      fillEntryValueUsd: entryValueUsd,
                      fillSolPriceUsd: solPrice,
                      fillActualTokenAmount: actualTokens ?? null,
                      fillTotalFeesSol: totalFeesSol || 0,
                  })
                : null;

            const scaleInTrailingStopPrice = mergedScaleIn
                ? resolveScaleInTrailingStopPrice({
                      existingTrailingStopPrice: existingOpenTrade?.trailingStopPrice ?? 0,
                      mergedEntryPriceSol: mergedScaleIn.mergedEntryPriceSol,
                      fillEntryPriceSol: entryPriceSol,
                  })
                : 0;

            let savedTrade: { id: number; slotNumber: number };
            if (existingOpenTrade) {
                // GUARDED WRITE (finding: scale-in-vs-close race). The on-chain reconciliation
                // above this block can take up to ~10s (polling retries), so a concurrent
                // executeSell can CLOSE this exact trade in that window. The previous
                // unconditional `where: { id }` update would then silently resurrect the
                // CLOSED trade back to OPEN using this stale pre-swap scale-in data. Guard the
                // write with `status: 'OPEN'` and use updateMany (not update) so we can check
                // the affected row count instead of relying on a thrown P2025.
                //
                // ADDITIONAL FIX (finding: scale-in-vs-partial-sell clobber): amountInSol /
                // entryValueUsd / totalFeesSol below are written via Prisma's atomic
                // `increment` with this FILL's own delta (finalAmountInSol / entryValueUsd /
                // totalFeesSol), not `mergedScaleIn`'s absolute pre-confirmation sum. A
                // concurrent partial-sell's atomic `multiply` (see recordExecutedSell) can
                // land on these same columns between the `existingOpenTrade` read above and
                // this write; incrementing by the fill's own delta -- instead of overwriting
                // with a sum computed from the stale snapshot -- applies on top of whatever
                // value is currently in the row, so it can never clobber that concurrent write
                // regardless of ordering. entryPrice/highestPrice/solPriceAtEntry remain
                // weighted-average values that cannot be expressed as a Prisma atomic
                // operator; they keep using `mergedScaleIn`'s stale-snapshot computation (a
                // separate, narrower, already-flagged gap -- see MINOR note on the sell side).
                const scaleInUpdate = await this.prismaService.trade.updateMany({
                    where: { id: existingOpenTrade.id, status: 'OPEN' },
                    data: {
                        tokenMint,
                        symbol: existingOpenTrade.symbol || symbol,
                        slotNumber: existingOpenTrade.slotNumber,
                        entryPrice: mergedScaleIn?.mergedEntryPriceSol ?? entryPriceSol,
                        entryPriceSol: mergedScaleIn?.mergedEntryPriceSol ?? entryPriceSol,
                        // A scale-in moves the averaged entry, so the monitor reference has to
                        // move with it; leaving the original would measure the enlarged position
                        // against a price it no longer has.
                        monitorEntryPrice: mergedScaleIn?.mergedEntryPriceSol ?? entryPriceSol,
                        entryPriceUsd:
                            mergedScaleIn && mergedScaleIn.totalTokenAmount > 0
                                ? mergedScaleIn.mergedEntryValueUsd / mergedScaleIn.totalTokenAmount
                                : entryPrice,
                        highestPrice: mergedScaleIn?.mergedHighestPriceSol ?? entryPriceSol,
                        trailingStopPrice: scaleInTrailingStopPrice,
                        status: 'OPEN',
                        mode: 'LIVE',
                        route: existingOpenTrade.route ?? route ?? null,
                        aiDecisionSnapshotId:
                            existingOpenTrade.aiDecisionSnapshotId ?? aiDecisionSnapshotId ?? null,
                        amountInSol: { increment: finalAmountInSol },
                        buyTxHash: existingOpenTrade.buyTxHash || txHash || null,
                        entryLiquidity:
                            existingOpenTrade.entryLiquidity ?? metadata?.liquidity ?? 0,
                        entryPairAddress:
                            existingOpenTrade.entryPairAddress ?? metadata?.pairAddress ?? null,
                        entryMarketCap:
                            existingOpenTrade.entryMarketCap ?? metadata?.marketCap ?? 0,
                        creatorAddress:
                            existingOpenTrade.creatorAddress ?? metadata?.creator ?? null,
                        topHolderAddress:
                            existingOpenTrade.topHolderAddress ?? metadata?.topHolder ?? null,
                        initialCreatorBalance:
                            existingOpenTrade.initialCreatorBalance ?? initialCreatorBalance,
                        initialTopHolderBalance:
                            existingOpenTrade.initialTopHolderBalance ?? initialTopHolderBalance,
                        targetTakeProfit:
                            existingOpenTrade.targetTakeProfit ?? options?.targetTakeProfit,
                        targetStopLoss: existingOpenTrade.targetStopLoss ?? options?.targetStopLoss,
                        targetTrailingDistance:
                            existingOpenTrade.targetTrailingDistance ??
                            options?.targetTrailingDistance,
                        telegramChatId: tradeChatDbId || null,
                        // Folded into this SAME guarded updateMany (rather than a separate
                        // unguarded `where: { id }` write afterward) so there is no second
                        // write-gap for a concurrent SELL's CLOSE update to land in and get
                        // silently overwritten with stale pre-close scale-in data.
                        solPriceAtEntry: mergedScaleIn?.mergedSolPriceAtEntry ?? solPrice,
                        entryValueUsd: { increment: entryValueUsd },
                        totalFeesSol: { increment: totalFeesSol || 0 },
                    },
                });
                if (scaleInUpdate.count === 0) {
                    // Trade was already CLOSED by a concurrent sell by the time this scale-in
                    // buy reconciled. Do NOT resurrect it. The buy DID land on-chain -- those
                    // extra tokens/SOL are real and now unaccounted for on the (closed) trade
                    // row -- so surface it loudly for manual reconciliation instead of silently
                    // reopening a trade the sell path already closed.
                    this.logger.error(
                        `[BuyTrace] SCALE-IN RACE: buy for ${tokenMint} chat=${telegramChatId} ` +
                            `tx=${txHash || 'n/a'} landed on-chain (solSpent=${finalAmountInSol}, ` +
                            `tokens=${actualTokens ?? 'unknown'}) but existing trade ` +
                            `id=${existingOpenTrade.id} was already CLOSED (concurrent sell) by the ` +
                            `time of reconciliation. Skipped DB resurrection. ACTIONABLE: manually ` +
                            `reconcile the extra tokens/SOL against trade id=${existingOpenTrade.id}.`,
                    );
                    try {
                        // NOT sendTradeFailureAlert: that template hardcodes "EXECUTION FAILED" /
                        // "No live trade was opened", both false here -- the buy DID land on-chain.
                        await this.reportingService.sendTradeReconciliationAlert({
                            side: 'BUY',
                            tokenMint,
                            symbol: existingOpenTrade.symbol || undefined,
                            reason: `scale_in_race_closed: ${existingOpenTrade.id}`,
                            targetChatId,
                            details:
                                `Scale-in BUY tx ${txHash || 'n/a'} landed on-chain (solSpent=` +
                                `${finalAmountInSol}, tokens=${actualTokens ?? 'unknown'}) but trade ` +
                                `id=${existingOpenTrade.id} was already CLOSED by a concurrent sell. ` +
                                `DB was NOT updated. ACTIONABLE: manually reconcile the extra ` +
                                `tokens/SOL against trade id=${existingOpenTrade.id}.`,
                        });
                    } catch (alertErr) {
                        const m = alertErr instanceof Error ? alertErr.message : String(alertErr);
                        this.logger.error(`[BuyTrace] Failed to send scale-in-race alert: ${m}`);
                    }
                    return {
                        success: true,
                        message:
                            `Scale-in buy for ${tokenMint} landed on-chain but the trade was already ` +
                            `closed by a concurrent sell; skipped DB update. Manual reconciliation required.`,
                    };
                }
                savedTrade = { id: existingOpenTrade.id, slotNumber: existingOpenTrade.slotNumber };
            } else {
                savedTrade = await this.prismaService.trade.create({
                    data: {
                        tokenMint,
                        symbol,
                        slotNumber: slotToUse,
                        entryPrice: entryPriceSol,
                        entryPriceSol,
                        entryPriceUsd: entryPrice,
                        monitorEntryPrice: resolveMonitorEntryPriceSol(
                            metadata?.priceUsd,
                            solPrice,
                            entryPriceSol,
                        ),
                        highestPrice: entryPriceSol,
                        trailingStopPrice: 0, // PriceMonitor activates it once the position is in profit.
                        status: 'OPEN',
                        mode: 'LIVE',
                        route,
                        aiDecisionSnapshotId,
                        amountInSol: finalAmountInSol,
                        buyTxHash: txHash || null,
                        entryLiquidity: metadata?.liquidity || 0,
                        entryPairAddress: metadata?.pairAddress || null,
                        entryMarketCap: metadata?.marketCap || 0,
                        creatorAddress: metadata?.creator,
                        topHolderAddress: metadata?.topHolder,
                        initialCreatorBalance,
                        initialTopHolderBalance,
                        targetTakeProfit: options?.targetTakeProfit,
                        targetStopLoss: options?.targetStopLoss,
                        targetTrailingDistance: options?.targetTrailingDistance,
                        telegramChatId: tradeChatDbId || null,
                    },
                });
            }

            if (!existingOpenTrade) {
                await this.updateTradeAuditFields(savedTrade.id, {
                    solPriceAtEntry: solPrice,
                    entryValueUsd,
                    totalFeesSol: totalFeesSol || 0,
                });
            }
            // else: scale-in already wrote solPriceAtEntry/entryValueUsd/totalFeesSol as part
            // of the guarded updateMany above -- no separate write needed (see comment there).

            if (existingOpenTrade) {
                this.logger.log(
                    `[Slot ${savedTrade.slotNumber}] Scale-in merged for ${symbol} (${tokenMint}) existingTradeId=${existingOpenTrade.id} tx=${txHash || 'n/a'} totalSol=${(mergedScaleIn?.mergedAmountInSol ?? finalAmountInSol).toFixed(6)} totalTokens=${(mergedScaleIn?.totalTokenAmount ?? 0).toFixed(6)} avgEntry=${(mergedScaleIn?.mergedEntryPriceSol ?? entryPriceSol).toFixed(10)} trailingStop=${scaleInTrailingStopPrice.toFixed(10)}`,
                );
            }
            this.logger.log(
                `[Slot ${savedTrade.slotNumber}] Successfully bought ${symbol} (${tokenMint})`,
            );
            this.logger.log(
                `[BuyTrace] Success token=${tokenMint} chat=${telegramChatId} slot=${savedTrade.slotNumber} tx=${txHash || 'n/a'}`,
            );
            const strategyName = options?.targetTakeProfit
                ? 'Established Rebound & CTO (TP 18%, TSL 2.5%, Hard SL 20%)'
                : 'Standard Second-Wave';
            await this.reportingService.sendBuyAlert(
                tokenMint,
                entryPrice,
                savedTrade.slotNumber,
                symbol,
                metadata?.socials,
                strategyName,
                {
                    solSpent: finalAmountInSol,
                    tokensReceived: actualTokens,
                    solPrice,
                },
                effectiveDryRun,
                targetChatId,
                existingOpenTrade ? 'SCALE-IN BUY' : 'BUY EXECUTION',
            );

            if (!isManualBuy) {
                await this.reportingService.sendSwapResultReport({
                    side: 'BUY',
                    tokenMint,
                    symbol,
                    success: true,
                    amountUsd: buyAmountUSD,
                    amountSol: finalAmountInSol,
                    txHash,
                    dryRun: effectiveDryRun,
                    targetChatId,
                });
            }

            // PriceMonitorService otomatis akan mendeteksi trade baru dari DB
            return {
                success: true,
                message: `Successfully bought ${symbol} at slot ${savedTrade.slotNumber}`,
            };
        }

        this.logger.warn(
            `[BuyTrace] Swap failed token=${tokenMint} chat=${telegramChatId}: ${error || 'Unknown error'}`,
        );
        await notifyBuyFailure({
            reason: error || 'swap_failed',
            details: error || 'Unknown error',
            amountUsd: buyAmountUSD,
            amountSol: amountInSol,
        });
        return { success: false, message: `Swap failed: ${error || 'Unknown error'}` };
    }

    async executeSell(
        tradeId: number,
        currentPrice: number,
        exitReason: string,
        percentage: number = 1.0,
        forceLive = false,
    ): Promise<boolean> {
        const baseTrade = await this.prismaService.trade.findUnique({
            where: { id: tradeId },
        });
        const trade = baseTrade
            ? ({
                  ...baseTrade,
                  ...(await this.getTradeAuditFields(baseTrade.id)),
              } as PrismaTrade & TradeAuditFields)
            : null;
        if (!trade || trade.status !== 'OPEN') {
            this.logger.debug(`[Trade ${tradeId}] Already closed or not found. Skipping sell.`);
            return false;
        }

        // 🛡️ IN-MEMORY LOCK: Prevent double-sell tanpa corrupt DB state
        if (this.sellingTrades.has(tradeId)) {
            this.logger.debug(`[Trade ${tradeId}] Sell already in progress. Skipping.`);
            return false;
        }
        this.sellingTrades.add(tradeId);

        let tradeDryRun = forceLive ? false : true;
        let targetChatId: string | undefined;

        try {
            // 1. DAPETIN SALDO ASLI ATAU SIMULASI
            let actualBalance = 0;
            const tradeSettings = trade.telegramChatId
                ? await this.telegramWorkspace.getChatSettingsByChatDbId(trade.telegramChatId)
                : null;
            tradeDryRun = forceLive ? false : (tradeSettings?.dryRun ?? true);
            const targetChat = trade.telegramChatId
                ? await this.telegramWorkspace.getChatByDbId(trade.telegramChatId)
                : null;
            targetChatId = targetChat?.chatId;

            if (tradeDryRun) {
                const solPrice = await this.getSolPrice();
                actualBalance = (trade.amountInSol * solPrice) / trade.entryPrice;
                this.logger.debug(
                    `[Slot ${trade.slotNumber}] 🤖 DRY RUN: Simulated token balance: ${actualBalance}`,
                );
            } else {
                if (!trade.telegramChatId) {
                    this.logger.error(
                        `[Slot ${trade.slotNumber}] Legacy live trade is not bound to a Telegram wallet. Aborting sell.`,
                    );
                    return false;
                }
                // IDEMPOTENCY RECONCILIATION (finding: post-broadcast guard discarded txid).
                // If a previous sell for this trade was broadcast but left UNCONFIRMED, resolve
                // that exact tx's on-chain fate BEFORE re-selling. This closes the double-sell
                // race: within the tx validity window the balance snapshot still shows the
                // un-sold tokens, so a blind re-sell would double-execute if the in-flight tx
                // then lands. After the validity window the balance is authoritative (a landed
                // tx has already reduced it), so a re-sell is safe.
                const pending = this.pendingSellSignatures.get(tradeId);
                if (pending) {
                    const fate = await this.resolveSignatureFate(pending);
                    if (fate === 'UNKNOWN') {
                        this.logger.warn(
                            `[Trade ${tradeId}] Prior sell tx ${pending.signature} still unconfirmed ` +
                                `and within its validity window — skipping this sell tick to avoid ` +
                                `double-execution. Will reconcile again on the next tick.`,
                        );
                        return false;
                    }
                    if (fate === 'LANDED_OK') {
                        // The prior broadcast sell ACTUALLY EXECUTED on-chain. Do NOT fall through
                        // to a fresh balance read: for a full exit the balance is now ≈0, so the
                        // zero-balance path would close the trade at exitPrice:0 / profitUsd:0 with
                        // no sell alert — the realized SOL proceeds would be lost and the operator
                        // never told. For a partial exit the balance read would re-sell the reduced
                        // runner, over-exiting it. Instead recover the real fill (mirroring the BUY
                        // reconciliation path) and record it exactly like a normal successful sell.
                        this.pendingSellSignatures.delete(tradeId);
                        const recWallet = await this.telegramWorkspace.getWalletKeypairByChatDbId(
                            trade.telegramChatId,
                        );
                        const recDetails = await this.getActualSwapDetails(
                            pending.signature,
                            recWallet.publicKey.toBase58(),
                            trade.tokenMint,
                            // Real Jito tip paid on the ORIGINAL broadcast, persisted in
                            // PendingSellStore at the time of that broadcast. Hardcoding 0
                            // here would permanently undercount totalFeesSol for any SELL
                            // that had to go through this cross-tick recovery path.
                            pending.jitoTipLamports ?? 0,
                            'SELL',
                        );
                        if (recDetails && Math.abs(recDetails.tokenChange) > 0) {
                            const recTokens = Math.abs(recDetails.tokenChange);
                            const recSol =
                                recDetails.cleanSolAmount ?? Math.abs(recDetails.solChange);
                            const recPercentage = pending.percentage ?? percentage;
                            const recExitReason = pending.exitReason ?? exitReason;
                            this.logger.warn(
                                `[Trade ${tradeId}] Reconciled LANDED prior sell ${pending.signature}: ` +
                                    `recovered fill tokens=${recTokens} sol=${recSol} pct=${recPercentage} ` +
                                    `reason=${recExitReason}. Recording realized proceeds (no re-sell).`,
                            );
                            return await this.recordExecutedSell({
                                trade,
                                tradeId,
                                percentage: recPercentage,
                                exitReason: recExitReason,
                                sellAmount: recTokens,
                                exitPriceResult: undefined,
                                actualSol: recSol,
                                actualTokens: recTokens,
                                txHash: pending.signature,
                                totalFeesSol: recDetails.totalFeesSol,
                                tradeDryRun,
                                targetChatId,
                                forceLive,
                            });
                        }
                        // The tx landed but its fill could not be parsed on-chain. Falling through
                        // to a balance-based sell here is unsafe (full exit → exitPrice:0 close with
                        // lost proceeds; partial → re-sell of the runner). Bail loudly so an operator
                        // can reconcile manually, per the project position-protection rule.
                        this.logger.error(
                            `[Trade ${tradeId}] Prior sell ${pending.signature} LANDED but its fill ` +
                                `could not be recovered on-chain. Skipping this tick; manual ` +
                                `reconciliation required. Trade left OPEN.`,
                        );
                        try {
                            // NOT sendTradeFailureAlert: that template hardcodes "EXECUTION FAILED" /
                            // "No live trade was opened", both false here -- the sell DID land on-chain
                            // and the trade is still OPEN.
                            await this.reportingService.sendTradeReconciliationAlert({
                                side: 'SELL',
                                tokenMint: trade.tokenMint,
                                symbol: trade.symbol || undefined,
                                reason: `sell_landed_unrecovered: ${pending.signature}`,
                                targetChatId,
                                details:
                                    `A prior SELL tx ${pending.signature} landed on-chain but its ` +
                                    `realized proceeds could not be parsed, so the trade row was NOT ` +
                                    `updated. ACTIONABLE: inspect the signature and reconcile the ` +
                                    `position manually.`,
                            });
                        } catch (alertErr) {
                            const m =
                                alertErr instanceof Error ? alertErr.message : String(alertErr);
                            this.logger.error(
                                `[Trade ${tradeId}] Failed to send landed-unrecovered alert: ${m}`,
                            );
                        }
                        return false;
                    }
                    // LANDED_FAILED / NOT_FOUND: the tx will never land — safe to re-sell.
                    this.pendingSellSignatures.delete(tradeId);
                    this.logger.log(
                        `[Trade ${tradeId}] Reconciled prior unconfirmed sell ${pending.signature}: ` +
                            `${fate}. Proceeding with balance-checked sell.`,
                    );
                }
                const wallet = await this.telegramWorkspace.getWalletKeypairByChatDbId(
                    trade.telegramChatId,
                );
                const fetchedBalance = await this.getTokenBalance(
                    wallet.publicKey.toBase58(),
                    trade.tokenMint,
                );
                if (fetchedBalance === null) {
                    this.logger.error(
                        `[Slot ${trade.slotNumber}] ❌ Failed to fetch balance from RPC. Aborting sell to prevent errors.`,
                    );
                    return false;
                }
                actualBalance = fetchedBalance;
            }

            const sellAmount = actualBalance * percentage;
            let decimals: number;
            try {
                decimals = await this.getTokenDecimalsStrict(trade.tokenMint);
            } catch (error) {
                if (error instanceof TokenDecimalsUnavailableError) {
                    this.queueSellRetry(tradeId, currentPrice, exitReason, percentage, 30_000);
                    return false;
                }
                throw error;
            }
            const amountInLamports = Math.floor(sellAmount * Math.pow(10, decimals));

            if (amountInLamports <= 0) {
                this.logger.warn(
                    `[Slot ${trade.slotNumber}] ⚠️ Zero balance for ${trade.tokenMint}. Closing trade.`,
                );
                if (percentage >= 1.0) {
                    // Guarded like the full-close/partial-sell writes below: a concurrent
                    // writer may have already closed this trade, so only flip status when
                    // it is still OPEN rather than unconditionally overwriting it.
                    const zeroBalanceUpdate = await this.prismaService.trade.updateMany({
                        where: { id: tradeId, status: 'OPEN' },
                        data: { status: 'CLOSED', exitPrice: 0, profitUsd: 0, exitReason },
                    });
                    if (zeroBalanceUpdate.count === 0) {
                        this.logger.warn(
                            `[Slot ${trade.slotNumber}] Zero-balance close for trade ${tradeId} skipped: already closed by a concurrent writer.`,
                        );
                    }
                }
                return false;
            }

            this.logger.log(
                `[Slot ${trade.slotNumber}] 💸 Executing SELL (${(percentage * 100).toFixed(0)}%) for ${trade.symbol} (${trade.tokenMint}). Amount: ${sellAmount}`,
            );

            // 2. PANIC SLIPPAGE: Kalau SL, Trailing Stop, atau Rugpull, hajar slippage 15% (1500 bps) biar pasti laku
            const isUrgent = [
                'STOP_LOSS',
                'STOP_LOSS_ZONE_TIMEOUT',
                'TRAILING_STOP',
                'DEV_DUMP',
                'RUGPULL',
                'PANIC_SELL',
                'AI_HEALTH_CRITICAL',
            ].includes(exitReason);
            const requestedSellSlippageBps = tradeSettings
                ? Math.max(1, Math.round(tradeSettings.slippageOnSol * 10000))
                : this.slippageBps;
            const sellSlippage = isUrgent ? 1500 : requestedSellSlippageBps;

            // 🚀 Panic Gas Accel: Hajar priority fee tinggi (0.0005 SOL = 500,000 lamports) biar instan masuk block pertama
            const sellPriorityFee = isUrgent ? 500_000 : undefined;
            if (!trade.telegramChatId) {
                this.logger.error(
                    `[Trade ${tradeId}] Legacy live trade is not bound to a Telegram wallet. Skipping sell.`,
                );
                return false;
            }
            const activeWallet = await this.telegramWorkspace.getWalletKeypairByChatDbId(
                trade.telegramChatId,
            );

            const {
                success,
                entryPrice: exitPriceResult,
                error,
                txHash,
                actualSol,
                actualTokens,
                totalFeesSol,
                jitoTipLamports,
            } = await this.executeJupiterSwap(
                trade.tokenMint,
                'So11111111111111111111111111111111111111112',
                amountInLamports,
                'SELL',
                // Jito-size gate notional (NOT used for SELL pricing). Prorate the entry COST
                // BASIS by the fraction being sold so a partial sell gates on the real leg size
                // (an un-prorated $3 basis on a 50% sell would wrongly keep Jito on a ~$1.5 leg).
                trade.entryValueUsd != null ? trade.entryValueUsd * percentage : undefined,
                0,
                sellSlippage,
                sellPriorityFee,
                activeWallet,
                tradeDryRun,
            );

            if (success) {
                return await this.recordExecutedSell({
                    trade,
                    tradeId,
                    percentage,
                    exitReason,
                    sellAmount,
                    exitPriceResult,
                    actualSol,
                    actualTokens,
                    txHash,
                    totalFeesSol,
                    tradeDryRun,
                    targetChatId,
                    forceLive,
                });
            }

            // ❌ SELL FAILED — trade tetap OPEN (tidak pernah di-CLOSED sebelum swap)
            this.logger.error(
                `[Slot ${trade.slotNumber}] ❌ SELL FAILED on Solana: ${error}. Trade remains OPEN for retry.`,
            );
            // IDEMPOTENCY (finding: post-broadcast guard discarded txid): a broadcast-but-
            // unconfirmed sell tx is AMBIGUOUS — it may still land. Record its deterministic
            // signature so the NEXT executeSell reconciles it on-chain (via the gate above)
            // before re-selling, instead of blind-selling a possibly-stale balance snapshot
            // (which double-sells if the in-flight tx lands). Only set for live trades that
            // actually returned a signature.
            if (!tradeDryRun && error?.startsWith('post_broadcast_unconfirmed') && txHash) {
                this.pendingSellSignatures.set(tradeId, {
                    signature: txHash,
                    recordedAt: Date.now(),
                    // Persist the exit size/reason so a later LANDED_OK reconciliation
                    // finalizes with the ORIGINAL intent — a full exit closes, a partial
                    // reduces the runner — instead of guessing from the current tick.
                    percentage,
                    exitReason,
                    // Persist the REAL tip paid on this broadcast so a later LANDED_OK
                    // reconciliation (which happens on a subsequent tick, after this call's
                    // local jitoTipLamports has gone out of scope) can pass it to
                    // getActualSwapDetails instead of hardcoding 0 and undercounting fees.
                    jitoTipLamports: jitoTipLamports ?? 0,
                });
                this.logger.warn(
                    `[Trade ${tradeId}] SELL broadcast but UNCONFIRMED (sig=${txHash}). ` +
                        `Recorded for on-chain reconciliation before any re-sell to avoid double-execution.`,
                );
            }
            if (error?.startsWith('price_anomaly')) {
                this.queuePriceAnomalyRetry(tradeId, currentPrice, exitReason, percentage);
            }

            // ESCALATION (proposal solana-stoploss-retry, requirement 4): a position-protecting
            // exit (stop-loss / trailing / rug / panic) that keeps failing while the position is
            // still OPEN is a real-money hazard, not a routine swap miss. Track consecutive
            // failures and, once the per-tick retry budget is exhausted, fire the project's
            // existing prominent failure alert (sendTradeFailureAlert) instead of only the routine
            // swap-result report, plus an ACTIONABLE console line for operators tailing logs.
            if (isUrgent) {
                const failures = (this.consecutiveSellFailures.get(tradeId) || 0) + 1;
                this.consecutiveSellFailures.set(tradeId, failures);
                const alertThreshold = Number.parseInt(
                    this.configService.get<string>('STOP_LOSS_ALERT_AFTER_FAILURES', '3'),
                    10,
                );
                const threshold =
                    Number.isFinite(alertThreshold) && alertThreshold > 0 ? alertThreshold : 3;
                if (failures >= threshold) {
                    console.error(
                        `[ACTIONABLE][STOP-LOSS] Trade ${tradeId} (${trade.symbol || trade.tokenMint}) ` +
                            `has FAILED to exit ${failures}x consecutively (reason=${exitReason}); position is STILL OPEN. ` +
                            `Manual intervention likely required. Last error: ${error || 'unknown'}`,
                    );
                    try {
                        await this.reportingService.sendTradeFailureAlert({
                            side: 'SELL',
                            tokenMint: trade.tokenMint,
                            symbol: trade.symbol || undefined,
                            stage: 'SWAP',
                            reason: `stop_loss_stuck_open_x${failures}: ${error || 'unknown'}`,
                            amountUsd: sellAmount * currentPrice,
                            targetChatId,
                            details:
                                `${exitReason.replace(/_/g, ' ')} could not execute after ${failures} attempts. ` +
                                `Position is STILL OPEN and exposed. ACTIONABLE: check RPC/DEX health or exit manually.`,
                        });
                    } catch (alertErr) {
                        const msg = alertErr instanceof Error ? alertErr.message : String(alertErr);
                        this.logger.error(
                            `[Trade ${tradeId}] Failed to send stop-loss escalation alert: ${msg}`,
                        );
                    }
                }
            }
            if (!forceLive) {
                await this.reportingService.sendSwapResultReport({
                    side: 'SELL',
                    tokenMint: trade.tokenMint,
                    symbol: trade.symbol || undefined,
                    success: false,
                    amountUsd: sellAmount * currentPrice,
                    error: error || 'Unknown error',
                    dryRun: tradeDryRun,
                    targetChatId,
                    details: `Exit reason: ${exitReason.replace(/_/g, ' ')}`,
                });
            }
            return false;
        } catch (error) {
            this.logger.error(
                `[Slot ${trade.slotNumber}] ❌ SELL CRITICAL ERROR: ${error instanceof Error ? error.message : String(error)}`,
            );
            if (!forceLive) {
                await this.reportingService.sendSwapResultReport({
                    side: 'SELL',
                    tokenMint: trade.tokenMint,
                    symbol: trade.symbol || undefined,
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    dryRun: tradeDryRun,
                    targetChatId,
                    details: `Exit reason: ${exitReason.replace(/_/g, ' ')}`,
                });
            }
            return false;
        } finally {
            this.sellingTrades.delete(tradeId);
        }
    }

    /**
     * Record an executed sell fill into the DB (CLOSE for a full exit, reduce+runner
     * for a partial) and fire the sell alert / swap-result report. Extracted from the
     * inline post-swap success path so the LANDED_OK reconciliation path records a
     * recovered on-chain fill through the SAME logic (identical PnL, close/partial and
     * alerting) instead of falling through to a balance read that loses proceeds.
     */
    private async recordExecutedSell(params: {
        trade: PrismaTrade & TradeAuditFields;
        tradeId: number;
        percentage: number;
        exitReason: string;
        sellAmount: number;
        exitPriceResult: number | undefined;
        actualSol: number | undefined;
        actualTokens: number | undefined;
        txHash: string | undefined;
        totalFeesSol: number | undefined;
        tradeDryRun: boolean;
        targetChatId: string | undefined;
        forceLive: boolean;
    }): Promise<boolean> {
        const {
            trade,
            tradeId,
            percentage,
            exitReason,
            sellAmount,
            exitPriceResult,
            actualSol,
            actualTokens,
            txHash,
            totalFeesSol,
            tradeDryRun,
            targetChatId,
            forceLive,
        } = params;
        const quotedExitPrice = exitPriceResult || 0;
        // 'SELL' priority: this feeds realizedPnl/exitPrice persisted to the trade record below
        // for a completed sell — real financial recording, not a display-only lookup — so it
        // must not queue behind the (lower-priority) BUY lane.
        const liveSellSolPrice = await this.getSolPriceOrNull('SELL');
        const safeSellSolPrice = resolveSafeSellSolPrice(
            liveSellSolPrice ?? 0,
            trade.solPriceAtEntry,
        );

        const fallbackSolPrice = safeSellSolPrice.solPrice || trade.solPriceAtEntry || 0;
        const finalSolReceived =
            actualSol ||
            (fallbackSolPrice > 0 ? (sellAmount * quotedExitPrice) / fallbackSolPrice : 0);
        const finalTokensSold = actualTokens || sellAmount;
        const entrySolValue = trade.amountInSol * percentage;
        const realizedPnl = calculateRealizedSellPnl({
            solSpent: entrySolValue,
            solReceived: finalSolReceived,
            entrySolPrice: trade.solPriceAtEntry,
            sellSolPrice: safeSellSolPrice.solPrice,
        });
        const exitPrice =
            finalTokensSold > 0 && safeSellSolPrice.solPrice > 0
                ? (finalSolReceived * safeSellSolPrice.solPrice) / finalTokensSold
                : quotedExitPrice;
        const profit = realizedPnl.usdProfitPercent;
        const estimatedProfitUsd = realizedPnl.usdProfit;
        const exitValueUsd = realizedPnl.usdReceived;
        const totalUsdSpent = realizedPnl.usdSpent;
        const totalUsdReceived = realizedPnl.usdReceived;
        const solProfitPercent = realizedPnl.solProfitPercent;

        this.logger.log(
            `[PNL] source=actual_sol token=${trade.tokenMint} solPnl=${solProfitPercent.toFixed(2)}% usdPnl=${profit.toFixed(2)}% solPriceSource=${safeSellSolPrice.source}`,
        );
        if (safeSellSolPrice.source !== 'live') {
            this.logger.warn(
                `[PNL] Live SOL price unavailable for ${trade.tokenMint}. USD sell report uses ${safeSellSolPrice.source}.`,
            );
        }

        // ✅ DATABASE UPDATE: Hanya dilakukan jika transaksi Solana SUKSES
        // GUARDED WRITE (finding: full-close branch had no status guard while the
        // partial-sell branch below did, and used a stale-snapshot absolute `profitUsd`
        // add). Mirror the partial-sell branch: guard with `status: 'OPEN'` via
        // updateMany. profitUsd itself is intentionally NOT part of this updateMany --
        // it's Float? with no @default, and Prisma's atomic `increment` is NULL-propagating
        // (NULL + x = NULL in SQL), which would permanently pin it at NULL. It's applied
        // afterwards via incrementTradeProfit(), a raw-SQL COALESCE("profitUsd", 0) + x
        // write, same pattern as incrementTradeFees below. `dbUpdateOk` gates every
        // downstream side effect below (profit/fee increment, sell alert, swap-result
        // report, return value) so a race-lost write never reports fabricated success.
        let dbUpdateOk: boolean;
        if (percentage >= 1.0) {
            const fullCloseUpdate = await this.prismaService.trade.updateMany({
                where: { id: tradeId, status: 'OPEN' },
                data: {
                    status: 'CLOSED',
                    exitPrice,
                    exitPriceUsd: exitPrice,
                    exitPriceSol: finalTokensSold > 0 ? finalSolReceived / finalTokensSold : null,
                    exitReason,
                    sellTxHash: txHash || null,
                },
            });
            dbUpdateOk = fullCloseUpdate.count > 0;
            if (!dbUpdateOk) {
                // The sell already landed on-chain but the trade row was no longer OPEN by
                // the time this write ran (mirrors the partial-sell race below). Do NOT
                // write -- surface loudly for manual reconciliation instead.
                this.logger.error(
                    `[Trade ${tradeId}] FULL SELL tx ${txHash || 'n/a'} landed on-chain ` +
                        `(sol=${finalSolReceived}, tokens=${finalTokensSold}) but the trade row ` +
                        `was no longer OPEN at write time. DB was NOT updated. ACTIONABLE: ` +
                        `manually reconcile the realized proceeds against trade id=${tradeId}.`,
                );
                try {
                    // NOT sendTradeFailureAlert: that template hardcodes "EXECUTION FAILED" /
                    // "No live trade was opened", both false here -- the sell DID land on-chain.
                    await this.reportingService.sendTradeReconciliationAlert({
                        side: 'SELL',
                        tokenMint: trade.tokenMint,
                        symbol: trade.symbol || undefined,
                        reason: `full_sell_race_closed: ${tradeId}`,
                        targetChatId,
                        details:
                            `Full SELL tx ${txHash || 'n/a'} landed on-chain (sol=` +
                            `${finalSolReceived}, tokens=${finalTokensSold}) but trade ` +
                            `id=${tradeId} was no longer OPEN when the DB write ran. DB was NOT ` +
                            `updated. ACTIONABLE: manually reconcile the realized proceeds ` +
                            `against trade id=${tradeId}.`,
                    });
                } catch (alertErr) {
                    const m = alertErr instanceof Error ? alertErr.message : String(alertErr);
                    this.logger.error(
                        `[Trade ${tradeId}] Failed to send full-sell-race alert: ${m}`,
                    );
                }
            }
        } else {
            const partialTakeProfitAt =
                exitReason === 'PARTIAL_TAKE_PROFIT' ? new Date() : trade.partialTakeProfitAt;
            const runnerFloorPercent = Number.parseFloat(
                this.configService.get<string>('RUNNER_BREAKEVEN_FLOOR_PERCENT') || '8',
            );
            const exitPriceSolForRunner =
                finalTokensSold > 0 ? finalSolReceived / finalTokensSold : 0;
            // undefined (not trade.trailingStopPrice) when this exit isn't a partial-TP: the
            // field is intentionally omitted from the write below rather than rewritten with
            // its own stale snapshot value (see guard comment).
            let runnerStopPrice: number | undefined;
            if (exitReason === 'PARTIAL_TAKE_PROFIT') {
                // Finding (MINOR): the floor used to be computed from `trade.entryPrice`, the
                // pre-swap snapshot read at the top of executeSell -- a concurrent scale-in
                // that changes entryPrice during the swap confirmation window (can take
                // seconds) would still floor the runner off the stale entry price. Re-read
                // entryPrice immediately before use to shrink that staleness window down to
                // this single query. Narrow blast radius: only this PARTIAL_TAKE_PROFIT floor
                // value, not principal/PnL accounting -- those are already race-safe above.
                const freshEntryPriceRow = await this.prismaService.trade.findUnique({
                    where: { id: tradeId },
                    select: { entryPrice: true },
                });
                const currentEntryPrice = freshEntryPriceRow?.entryPrice ?? trade.entryPrice;
                const runnerFloorPrice =
                    currentEntryPrice *
                    (1 + (Number.isFinite(runnerFloorPercent) ? runnerFloorPercent : 8) / 100);
                // Never let the break-even floor sit at/above the current price, or the
                // runner would be liquidated on the next tick (guards a misconfigured floor
                // set above the take-profit trigger). exitPrice = partial-TP price.
                runnerStopPrice = Math.min(runnerFloorPrice, exitPriceSolForRunner * 0.999);
            }

            // GUARDED WRITE (finding: partial-sell vs scale-in race). `trade` here is a
            // snapshot read at the top of executeSell, before the swap broadcast/confirmation
            // (which can take seconds) -- a concurrent scale-in buy's guarded updateMany
            // (above, ~line 1471) can land in that window and update these SAME columns on
            // this SAME row. The previous unconditional `where: { id }` `update` wrote
            // absolute values computed from this stale snapshot, silently discarding
            // whichever side wrote last. amountInSol/entryValueUsd are now written with
            // Prisma's atomic `multiply` operator -- the DB applies it to whatever value is
            // currently in the row, so it can never clobber a concurrent write regardless of
            // ordering. trailingStopPrice is only included when this exit actually intends to
            // change it (PARTIAL_TAKE_PROFIT), instead of always rewriting the stale
            // pre-race value back. `status: 'OPEN'` mirrors the scale-in guard so a trade
            // closed by something else is never silently rewritten.
            const partialSellUpdate = await this.prismaService.trade.updateMany({
                where: { id: tradeId, status: 'OPEN' },
                data: {
                    amountInSol: { multiply: 1 - percentage },
                    entryValueUsd: { multiply: 1 - percentage },
                    partialTakeProfitAt,
                    ...(runnerStopPrice !== undefined
                        ? { trailingStopPrice: runnerStopPrice }
                        : {}),
                },
            });
            dbUpdateOk = partialSellUpdate.count > 0;
            if (partialSellUpdate.count === 0) {
                // The sell already landed on-chain (tokens sold, SOL received) but the trade
                // row was no longer OPEN by the time this write ran. Do NOT write -- there is
                // no safe absolute value to fall back to. Surface loudly for manual
                // reconciliation instead of silently doing nothing.
                this.logger.error(
                    `[Trade ${tradeId}] PARTIAL SELL tx ${txHash || 'n/a'} landed on-chain ` +
                        `(sol=${finalSolReceived}, tokens=${finalTokensSold}) but the trade row ` +
                        `was no longer OPEN at write time. DB was NOT updated. ACTIONABLE: ` +
                        `manually reconcile the realized proceeds against trade id=${tradeId}.`,
                );
                try {
                    // NOT sendTradeFailureAlert: that template hardcodes "EXECUTION FAILED" /
                    // "No live trade was opened", both false here -- the sell DID land on-chain.
                    await this.reportingService.sendTradeReconciliationAlert({
                        side: 'SELL',
                        tokenMint: trade.tokenMint,
                        symbol: trade.symbol || undefined,
                        reason: `partial_sell_race_closed: ${tradeId}`,
                        targetChatId,
                        details:
                            `Partial SELL tx ${txHash || 'n/a'} landed on-chain (sol=` +
                            `${finalSolReceived}, tokens=${finalTokensSold}) but trade ` +
                            `id=${tradeId} was no longer OPEN when the DB write ran. DB was NOT ` +
                            `updated. ACTIONABLE: manually reconcile the realized proceeds ` +
                            `against trade id=${tradeId}.`,
                    });
                } catch (alertErr) {
                    const m = alertErr instanceof Error ? alertErr.message : String(alertErr);
                    this.logger.error(
                        `[Trade ${tradeId}] Failed to send partial-sell-race alert: ${m}`,
                    );
                }
            }
        }
        // Gated on dbUpdateOk: if the trade row write above was skipped (race-lost --
        // count === 0), the operator was already told "No data was overwritten. Manual
        // reconciliation required." Silently bumping totalFeesSol/profitUsd here would
        // contradict that alert on the exact same row.
        // profitUsd increment is split out of the updateMany above (see incrementTradeProfit)
        // and always applied -- not gated on truthiness like totalFeesSol -- so a null
        // profitUsd is coalesced to 0 even on a break-even (0 profit) sell.
        if (dbUpdateOk) {
            await this.incrementTradeProfit(tradeId, estimatedProfitUsd);
        }
        if (dbUpdateOk && totalFeesSol) {
            await this.incrementTradeFees(tradeId, totalFeesSol);
        }

        let netProfitUsd = estimatedProfitUsd;
        let netProfitPercent = profit;
        let cumulativeFeesSol = totalFeesSol || 0;
        let cumulativeFeesUsd = cumulativeFeesSol * (trade.solPriceAtEntry || 0);
        let triggerPnlPercent: number | undefined;
        if (dbUpdateOk) {
            const persisted = await this.prismaService.trade.findUnique({
                where: { id: tradeId },
                select: {
                    profitUsd: true,
                    totalFeesSol: true,
                    solPriceAtEntry: true,
                    entryValueUsd: true,
                    exitTriggerPnlPercent: true,
                },
            });
            if (persisted) {
                netProfitUsd = computeNetProfitUsd(persisted);
                cumulativeFeesSol = persisted.totalFeesSol || 0;
                cumulativeFeesUsd = cumulativeFeesSol * (persisted.solPriceAtEntry || 0);
                const netBasisUsd = trade.entryValueUsd || totalUsdSpent;
                netProfitPercent = netBasisUsd > 0 ? (netProfitUsd / netBasisUsd) * 100 : profit;
                triggerPnlPercent = persisted.exitTriggerPnlPercent ?? undefined;
                await this.prismaService.trade.update({
                    where: { id: tradeId },
                    data: { netProfitUsd },
                });
            }
        }

        // 🧑‍💻 AUTO BLACKLIST ON CREATOR/LIQUIDITY RUG SIGNALS (Self-Learning)
        if (
            ['DEV_DUMP', 'RUGPULL', 'LIQUIDITY_RUGPULL'].includes(exitReason) &&
            trade.creatorAddress
        ) {
            try {
                const existingProfile = await this.prismaService.creatorProfile.findUnique({
                    where: { address: trade.creatorAddress },
                });
                const ruggedCount = (existingProfile?.ruggedTokens || 0) + 1;
                const createdCount = existingProfile?.tokensCreated || 1;
                const tags = new Set(existingProfile?.tags || []);
                tags.add('Serial Rugger');

                await this.prismaService.creatorProfile.upsert({
                    where: { address: trade.creatorAddress },
                    update: {
                        reason: exitReason,
                        ruggedTokens: ruggedCount,
                        isBlacklisted: true,
                        riskScore: 100, // Instant blacklist
                        tags: Array.from(tags),
                        lastActiveAt: new Date(),
                    },
                    create: {
                        address: trade.creatorAddress,
                        reason: exitReason,
                        tokensCreated: createdCount,
                        ruggedTokens: 1,
                        isBlacklisted: true,
                        riskScore: 100,
                        tags: ['Serial Rugger'],
                    },
                });
                this.logger.warn(
                    `[Blacklist] Automatically blacklisted creator ${trade.creatorAddress} for: ${exitReason}`,
                );
            } catch (dbErr) {
                const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
                this.logger.error(
                    `[Blacklist] Failed to blacklist creator ${trade.creatorAddress}: ${msg}`,
                );
            }
        }

        // Gated on dbUpdateOk: a race-lost write (count === 0) already fired the "landed
        // on-chain but NOT recorded, manual reconciliation required" alert above. Firing a
        // routine success alert with fabricated profit/exit numbers for the SAME event
        // right after would directly contradict it.
        if (dbUpdateOk) {
            const entryPriceUsdForReport =
                finalTokensSold > 0 && trade.solPriceAtEntry
                    ? (entrySolValue / finalTokensSold) * trade.solPriceAtEntry
                    : trade.entryPrice;

            await this.reportingService.sendSellAlert(
                trade.tokenMint,
                exitPrice,
                netProfitPercent,
                exitReason,
                trade.symbol || undefined,
                {
                    entryPriceUsd: entryPriceUsdForReport,
                    exitPriceUsd: exitPrice,
                    entryPriceSol: entrySolValue / finalTokensSold,
                    exitPriceSol: finalSolReceived / finalTokensSold,
                    solSpent: entrySolValue,
                    solReceived: finalSolReceived,
                    solProfitPercent,
                    usdSpent: totalUsdSpent,
                    usdReceived: totalUsdReceived,
                    triggerPnlPercent,
                    grossFillPnlPercent: profit,
                    feesSol: cumulativeFeesSol,
                    feesUsd: cumulativeFeesUsd,
                    netProfitUsd,
                    netProfitPercent,
                },
                tradeDryRun,
                targetChatId,
            );
            if (!forceLive) {
                await this.reportingService.sendSwapResultReport({
                    side: 'SELL',
                    tokenMint: trade.tokenMint,
                    symbol: trade.symbol || undefined,
                    success: true,
                    amountUsd: exitValueUsd,
                    amountSol: finalSolReceived,
                    txHash,
                    dryRun: tradeDryRun,
                    targetChatId,
                    details: `Exit reason: ${exitReason.replace(/_/g, ' ')}`,
                });
            }
        }
        this.consecutiveSellFailures.delete(tradeId);
        return dbUpdateOk;
    }

    private getEntryValueUsdForSell(
        trade: { id: number; amountInSol: number; entryValueUsd?: number | null },
        percentage: number,
        currentSolPrice: number,
    ): number {
        if (trade.entryValueUsd !== null && trade.entryValueUsd !== undefined) {
            return trade.entryValueUsd * percentage;
        }

        this.logger.warn(
            `[Trade ${trade.id}] entryValueUsd missing. Falling back to legacy current SOL price calculation; backfill this trade.`,
        );
        return trade.amountInSol * percentage * currentSolPrice;
    }

    private queueSellRetry(
        tradeId: number,
        currentPrice: number,
        exitReason: string,
        percentage: number,
        delayMs: number,
    ) {
        const retryCount = (this.sellRetryCounts.get(tradeId) || 0) + 1;
        this.sellRetryCounts.set(tradeId, retryCount);

        if (retryCount > 3) {
            this.logger.error(
                `[Trade ${tradeId}] Sell retry limit reached after decimals failure. Admin action required.`,
            );
            return;
        }

        this.logger.warn(`[Trade ${tradeId}] Queueing sell retry ${retryCount}/3 in ${delayMs}ms.`);
        setTimeout(() => {
            void this.executeSell(tradeId, currentPrice, exitReason, percentage);
        }, delayMs);
    }

    private queuePriceAnomalyRetry(
        tradeId: number,
        currentPrice: number,
        exitReason: string,
        percentage: number,
    ) {
        const retryCount = (this.priceAnomalyCounts.get(tradeId) || 0) + 1;
        this.priceAnomalyCounts.set(tradeId, retryCount);

        if (retryCount > 3) {
            this.logger.error(
                `[Trade ${tradeId}] Price anomaly repeated 3 times. Escalating to admin notification.`,
            );
            void this.reportingService.sendSellAlert(
                'UNKNOWN',
                currentPrice,
                0,
                'PRICE_ANOMALY_ADMIN_REVIEW',
                undefined,
                undefined,
                true,
            );
            return;
        }

        this.logger.warn(
            `[Trade ${tradeId}] Queueing price anomaly retry ${retryCount}/3 in 60000ms.`,
        );
        setTimeout(() => {
            void this.executeSell(tradeId, currentPrice, exitReason, percentage);
        }, 60_000);
    }

    /**
     * Resolve the on-chain fate of a broadcast-but-unconfirmed sell signature so the
     * caller can decide whether re-selling is safe (idempotency reconciliation for the
     * post-broadcast failure path).
     *
     *   LANDED_OK     — tx is confirmed/finalized with no error; the sell executed.
     *   LANDED_FAILED — tx landed but reverted; the tokens were NOT sold.
     *   NOT_FOUND     — tx cannot be found AND its validity window has elapsed, so it can
     *                   never land; the balance is now authoritative → safe to re-sell.
     *   UNKNOWN       — tx is not yet confirmed and is still within its validity window (or
     *                   the status RPC itself failed); its fate is genuinely ambiguous, so
     *                   the caller MUST NOT re-sell yet (would risk a double-sell).
     *
     * The validity window is bounded by SELL_UNCONFIRMED_TTL_MS (default 90s ≈ Solana's
     * ~150-block blockhash lifetime). Crucially, after the window a re-sell is safe
     * regardless of RPC state: if the tx had landed it already reduced the balance, and if
     * it did not it can never land — either way the fresh balance read reflects reality.
     */
    private async resolveSignatureFate(pending: {
        signature: string;
        recordedAt: number;
    }): Promise<'LANDED_OK' | 'LANDED_FAILED' | 'NOT_FOUND' | 'UNKNOWN'> {
        const configuredTtl = Number.parseInt(
            this.configService.get<string>('SELL_UNCONFIRMED_TTL_MS', '90000'),
            10,
        );
        const ttlMs = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 90_000;
        const windowElapsed = Date.now() - pending.recordedAt > ttlMs;
        try {
            const res = await this.connection.getSignatureStatus(pending.signature, {
                searchTransactionHistory: true,
            });
            const status = res?.value;
            if (status) {
                if (status.err) return 'LANDED_FAILED';
                const conf = status.confirmationStatus;
                if (
                    conf === 'confirmed' ||
                    conf === 'finalized' ||
                    (status.confirmations ?? 0) > 0
                ) {
                    return 'LANDED_OK';
                }
                // 'processed' only: still settling. Treat as landed once the window elapses
                // (a processed tx does not roll back after its blockhash expires).
                return windowElapsed ? 'LANDED_OK' : 'UNKNOWN';
            }
            // Not found: may still be in-flight within the window; only definitively gone
            // (and thus safe to re-sell) once the validity window has passed.
            return windowElapsed ? 'NOT_FOUND' : 'UNKNOWN';
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
                `[Trade] Signature reconciliation RPC error for ${pending.signature}: ${msg}. ` +
                    `${windowElapsed ? 'Validity window elapsed — balance is authoritative.' : 'Deferring re-sell (fate still ambiguous).'}`,
            );
            // Cannot prove the tx did NOT land. Within the window that is unsafe → UNKNOWN;
            // past the window the balance is authoritative regardless → NOT_FOUND.
            return windowElapsed ? 'NOT_FOUND' : 'UNKNOWN';
        }
    }

    private async executeJupiterSwap(
        inputMint: string,
        outputMint: string,
        amount: number,
        side: 'BUY' | 'SELL',
        buyAmountUSD?: number,
        retryCount = 0,
        customSlippageBps?: number,
        priorityFeeLamports?: number,
        wallet?: Keypair,
        dryRun = false,
        route?: TradeRoute,
        // Error classification of the failure that triggered THIS retry attempt (i.e.
        // the errorClass of the immediately preceding attempt). Threaded through the
        // recursive retry so SELL slippage escalation can distinguish a genuine
        // market/execution retry cause from a rate-limit (429) retry, which has
        // nothing to do with actual market slippage.
        lastErrorClass?: RpcErrorClass,
        buySignal?: Pick<BuyExecutionOptions, 'signalObservedAt' | 'signalPriceUsd'>,
    ): Promise<{
        success: boolean;
        entryPrice: number;
        error?: string;
        txHash?: string;
        actualSol?: number;
        actualTokens?: number;
        totalFeesSol?: number;
        // Jito tip actually paid for the broadcast attempt this result reflects (0 if Jito
        // was not used). Populated on the post-broadcast-unconfirmed failure path so callers'
        // on-chain recovery/reconciliation can reuse the REAL tip instead of hardcoding 0
        // (finding: hardcoding 0 there permanently undercounts totalFeesSol for any swap that
        // had to go through crash/idempotency recovery after actually paying a Jito tip).
        jitoTipLamports?: number;
    }> {
        const maxRetries = Number.parseInt(
            this.configService.get<string>('TRADE_MAX_RETRIES', '5'),
            10,
        );
        if (side === 'BUY') {
            const signalError = evaluateBuySignalGuard({
                ...buySignal,
                now: Date.now(),
                maxSignalAgeMs: this.getNumberConfig('MAX_BUY_SIGNAL_AGE_MS', 8000),
                maxChasePct: this.getNumberConfig('MAX_BUY_CHASE_PCT', 5),
            });
            if (signalError) {
                return { success: false, entryPrice: 0, error: signalError };
            }
        }
        if (!wallet) {
            throw new Error('Live swap execution requires a chat wallet.');
        }
        const activeWallet = wallet;
        // IDEMPOTENCY GUARD (proposal solana-stoploss-retry, requirement 3): once the
        // transaction has been broadcast to the network, a thrown confirmation error is
        // AMBIGUOUS — the swap may already have landed on-chain. Re-quoting and re-sending
        // in that state risks a double-sell, which is worse than the original 429 bug. So we
        // only allow the internal recursive retry for PRE-broadcast failures (quote/build/send
        // rejected). Post-broadcast failures return control to executeSell, which re-fetches the
        // live on-chain balance before any further attempt.
        let broadcasted = false;
        // Deterministic on-chain signature of the signed tx, captured BEFORE the wire
        // send. On a post-broadcast confirmation failure this is handed back to the
        // caller (instead of being discarded as undefined) so the ambiguous tx can be
        // reconciled on-chain before any re-sell — even if sendRawTransaction itself
        // timed out before returning a txid.
        let broadcastSignature: string | undefined;
        // Jito tip for this attempt. Declared outside the try block (unlike the other Jito
        // locals) so the post-broadcast-unconfirmed catch below can hand the real value back
        // to the caller instead of that path losing it to block scoping.
        let jitoTipLamports = 0;
        try {
            // Jurus Pamungkas: Pakai Paid Endpoint & API Key
            const hostname = 'api.jup.ag';
            const baseUrl = `https://${hostname}`;

            this.logger.log(
                `[Jupiter] Fetching quote for ${side} (Attempt ${retryCount + 1}/${maxRetries})...`,
            );

            const timeout = Number.parseInt(
                this.configService.get<string>('TRADE_TIMEOUT_MS', '20000'),
                10,
            );
            const config = {
                timeout,
                headers: {
                    'Accept-Encoding': 'gzip, deflate, br',
                    'x-api-key': this.jupiterApiKey,
                },
                httpsAgent: this.httpsAgent,
            };

            const requestedSlippageBps = customSlippageBps || this.slippageBps;
            let slippage = requestedSlippageBps;
            if (side === 'BUY') {
                const routeMaxSlippageBps = this.getRouteMaxSlippageBps(route);
                const initialSlippage = capSlippageBps(requestedSlippageBps, routeMaxSlippageBps);
                slippage = initialSlippage;
                if (initialSlippage < requestedSlippageBps) {
                    this.logger.warn(
                        `[Jupiter] SLIPPAGE_CAPPED route=${route ?? 'GLOBAL'} requestedSlippageBps=${requestedSlippageBps} selectedSlippageBps=${initialSlippage}`,
                    );
                }
                if (retryCount > 0) {
                    const proposedRetrySlippage = initialSlippage + retryCount * 250;
                    slippage = capSlippageBps(proposedRetrySlippage, routeMaxSlippageBps);
                    this.logger.warn(
                        `[Jupiter] Retrying route=${route ?? 'GLOBAL'} proposedSlippageBps=${proposedRetrySlippage} cappedSlippageBps=${slippage}`,
                    );
                }
            } else if (retryCount > 0 && lastErrorClass === 'RATE_LIMIT') {
                // A 429/rate-limit failure is not evidence of market movement — reuse the
                // base slippage instead of escalating, so we don't widen slippage
                // tolerance for a reason unrelated to actual price/execution risk.
                slippage = requestedSlippageBps;
                this.logger.warn(
                    `[Jupiter] Retrying SELL after RATE_LIMIT: keeping base slippage ${slippage} bps (no escalation)`,
                );
            } else if (retryCount > 0) {
                slippage = Math.min(requestedSlippageBps + retryCount * 250, 2000);
                this.logger.warn(`[Jupiter] Retrying SELL with higher slippage: ${slippage} bps`);
            }
            const quoteUrl = `${baseUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}`;
            // Routed through JupiterLimiter (not raw axios) so this call is spaced/prioritized
            // against every other Jupiter request: SELL quotes jump ahead of BUY quotes, and a
            // 429 here is handled by the limiter's own SELL-retry/BUY-abort rule BEFORE it ever
            // reaches the existing higher-level retry/backoff below.
            const quoteResponse = await JupiterLimiter.get(quoteUrl, side, config);
            const quoteData = quoteResponse.data;
            // PRICE IMPACT GUARD: route-aware and normalized for Jupiter response variants.
            if (side === 'BUY' && quoteData.priceImpactPct !== undefined) {
                const rawPriceImpactPct = quoteData.priceImpactPct;
                const priceImpact = normalizePriceImpactPct(rawPriceImpactPct);
                const maxPriceImpact = this.getRouteMaxPriceImpactPct(route);
                this.logger.log(
                    `[Jupiter] PriceImpact route=${route ?? 'GLOBAL'} rawPriceImpactPct=${rawPriceImpactPct} normalizedPriceImpactPct=${priceImpact.toFixed(4)} maxPriceImpactPct=${maxPriceImpact}`,
                );
                if (priceImpact > maxPriceImpact) {
                    this.logger.warn(
                        `[Jupiter] BUY rejected due to high price impact: ${priceImpact.toFixed(4)}% (Max allowed: ${maxPriceImpact}%) route=${route ?? 'GLOBAL'}`,
                    );
                    return {
                        success: false,
                        entryPrice: 0,
                        error: `PRICE_IMPACT_GUARD: raw=${rawPriceImpactPct}, normalized=${priceImpact.toFixed(4)}%, max=${maxPriceImpact}%`,
                    };
                }
            }
            if (side === 'BUY' && this.getBooleanConfig('ENABLE_PREBUY_SELLABILITY_GUARD', true)) {
                const minimumBoughtAmount = quoteData.otherAmountThreshold ?? quoteData.outAmount;
                if (!minimumBoughtAmount || Number(minimumBoughtAmount) <= 0) {
                    return {
                        success: false,
                        entryPrice: 0,
                        error: 'sellability_guard_malformed_buy_quote',
                    };
                }

                const reverseQuoteUrl =
                    `${baseUrl}/swap/v1/quote?inputMint=${outputMint}` +
                    `&outputMint=${inputMint}&amount=${minimumBoughtAmount}&slippageBps=${slippage}`;
                try {
                    const reverseQuoteResponse = await JupiterLimiter.get(
                        reverseQuoteUrl,
                        'BUY',
                        config,
                    );
                    const reverseQuote = reverseQuoteResponse.data;
                    const minimumRecoveredLamports =
                        reverseQuote?.otherAmountThreshold ?? reverseQuote?.outAmount;
                    const roundtripLossPct = calculateRoundtripLossPct(
                        amount,
                        minimumRecoveredLamports,
                    );
                    if (roundtripLossPct === null) {
                        return {
                            success: false,
                            entryPrice: 0,
                            error: 'sellability_guard_no_route',
                        };
                    }
                    const maxRoundtripLossPct = this.getRouteMaxRoundtripLossPct(route);
                    this.logger.log(
                        `[Sellability] token=${outputMint} route=${route ?? 'GLOBAL'} worstCaseRoundtripLoss=${roundtripLossPct.toFixed(2)}% max=${maxRoundtripLossPct}%`,
                    );
                    if (roundtripLossPct > maxRoundtripLossPct) {
                        return {
                            success: false,
                            entryPrice: 0,
                            error:
                                `sellability_guard_roundtrip_loss:${roundtripLossPct.toFixed(2)}` +
                                `>max:${maxRoundtripLossPct}`,
                        };
                    }
                } catch (reverseQuoteError) {
                    const reason =
                        reverseQuoteError instanceof Error
                            ? reverseQuoteError.message
                            : String(reverseQuoteError);
                    this.logger.warn(
                        `[Sellability] Reverse quote unavailable for ${outputMint}: ${reason}`,
                    );
                    return {
                        success: false,
                        entryPrice: 0,
                        error: `sellability_guard_unavailable:${reason}`,
                    };
                }
            }
            let price = 0;
            const tokenMintForDecimals = side === 'BUY' ? outputMint : inputMint;
            let decimals: number;
            try {
                decimals = await this.getTokenDecimalsStrict(tokenMintForDecimals);
            } catch (error) {
                if (error instanceof TokenDecimalsUnavailableError) {
                    return {
                        success: false,
                        entryPrice: 0,
                        error:
                            side === 'BUY'
                                ? 'cancelled_decimals_unavailable'
                                : 'decimals_unavailable',
                    };
                }
                throw error;
            }
            if (side === 'BUY') {
                const usdValue = buyAmountUSD || this.positionSizeUSD;
                price = usdValue / (quoteData.outAmount / Math.pow(10, decimals));
                const signalError = evaluateBuySignalGuard({
                    ...buySignal,
                    quotePriceUsd: price,
                    now: Date.now(),
                    maxSignalAgeMs: this.getNumberConfig('MAX_BUY_SIGNAL_AGE_MS', 8000),
                    maxChasePct: this.getNumberConfig('MAX_BUY_CHASE_PCT', 5),
                });
                if (signalError) {
                    return { success: false, entryPrice: 0, error: signalError };
                }
            } else {
                // SELL: Price = (outAmount_sol * solPrice) / inAmount_token.
                // Do not use the legacy $150 SOL fallback here; it can create fake USD profit.
                // 'SELL' priority: this call is part of the SELL's own critical path (its
                // result feeds calculatedPrice/validateSellPrice below, gating whether the
                // swap proceeds at all), not an informational lookup — it must not queue
                // behind unrelated SELL-lane traffic the way the default BUY-lane priority
                // would (BUY always drains last, see JupiterLimiter class doc).
                const solPrice = await this.getSolPriceOrNull('SELL');
                const outAmountSol = quoteData.outAmount / 1_000_000_000;
                const inAmountToken = amount / Math.pow(10, decimals);
                const calculatedPrice =
                    solPrice && inAmountToken > 0 ? (outAmountSol * solPrice) / inAmountToken : 0;
                const fallbackPrice = await this.getSellPriceFallback(inputMint);
                price =
                    calculatedPrice > 0 || fallbackPrice
                        ? validateSellPrice(calculatedPrice, fallbackPrice, inputMint, this.logger)
                        : 0.00000001;
            }

            // 🤖 DRY RUN MODE: Skip actual swap execution, just return simulated success with quote price
            if (dryRun) {
                this.logger.log(
                    `[DRY RUN] 🤖 Simulated ${side} Quote obtained: $${price.toFixed(8)}. Skipping real transaction.`,
                );
                return {
                    success: true,
                    entryPrice: price || 0.00000001,
                    txHash: `simulated_tx_${Date.now()}`,
                };
            }

            // ⛽ DYNAMIC FEES: Naikin gas tiap kali gagal (Auto-Multiplier + Retry Bonus)
            const useJitoConfigured = this.configService.get<string>('USE_JITO') === 'true';
            const jitoMinPositionUsd = Number.parseFloat(
                this.configService.get<string>('JITO_MIN_POSITION_USD') || '3',
            );
            const swapNotionalUsd = buyAmountUSD ?? this.positionSizeUSD;
            const jitoAllowedForSize =
                !Number.isFinite(jitoMinPositionUsd) || swapNotionalUsd >= jitoMinPositionUsd;
            const useJito = useJitoConfigured && retryCount === 0 && jitoAllowedForSize;
            if (useJitoConfigured && !jitoAllowedForSize) {
                this.logger.log(
                    `[Jupiter] Skipping Jito for small ${side} notional ` +
                        `$${swapNotionalUsd.toFixed(2)} < $${jitoMinPositionUsd} (avoids fixed tip drag).`,
                );
            }
            const jitoBlockEngineUrl =
                this.configService.get<string>('JITO_BLOCK_ENGINE_URL') ||
                'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
            const jitoTipSol = Number.parseFloat(
                this.configService.get<string>('JITO_TIP_SOL') || '0.0001',
            );

            const baseMultiplier = Number.parseInt(
                this.configService.get<string>('TRADE_PRIORITY_MULTIPLIER', '2'),
                10,
            );
            const multiplier = baseMultiplier + retryCount * 2;
            let feeConfig: number | { autoMultiplier: number } =
                priorityFeeLamports && priorityFeeLamports > 0
                    ? priorityFeeLamports
                    : { autoMultiplier: multiplier };

            if (useJito) {
                feeConfig = 0; // Jito relies on bundle tip, not priority fee
                this.logger.debug(`[Jupiter] 🚀 Using Jito MEV. Jupiter priority fee set to 0.`);
            } else if (useJitoConfigured && retryCount > 0) {
                this.logger.warn(
                    '[Jupiter] Falling back to direct send on retry to avoid bundle expiry.',
                );
            }

            // Routed through JupiterLimiter for the same reason as the quote call above.
            const swapResponse = await JupiterLimiter.post(
                `${baseUrl}/swap/v1/swap`,
                {
                    quoteResponse: quoteData,
                    userPublicKey: activeWallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: feeConfig,
                },
                side,
                config,
            );

            const transaction = VersionedTransaction.deserialize(
                Buffer.from(swapResponse.data.swapTransaction, 'base64'),
            );
            transaction.sign([activeWallet]);
            // A Solana signature is deterministic over the signed message, so the exact
            // on-chain signature is known here, BEFORE broadcasting. Both the Jito path
            // (txid = signatures[0]) and the direct path (sendRawTransaction returns the
            // same signature) resolve to this value. Capturing it now guarantees the
            // post-broadcast failure path can reconcile the tx even if the send call
            // itself throws before returning a txid.
            broadcastSignature = bs58.encode(transaction.signatures[0]);
            const confirmationBlockhash = transaction.message.recentBlockhash;
            const swapLastValidBlockHeight = Number(swapResponse.data?.lastValidBlockHeight);
            const hasSwapLastValidBlockHeight =
                Number.isFinite(swapLastValidBlockHeight) && swapLastValidBlockHeight > 0;
            jitoTipLamports = useJito ? Math.floor(jitoTipSol * 1_000_000_000) : 0;

            let txid = '';

            if (useJito) {
                const randomTipAccount = await this.getJitoTipAccount();

                const tx2Message = new TransactionMessage({
                    payerKey: activeWallet.publicKey,
                    recentBlockhash: transaction.message.recentBlockhash,
                    instructions: [
                        SystemProgram.transfer({
                            fromPubkey: activeWallet.publicKey,
                            toPubkey: new PublicKey(randomTipAccount),
                            lamports: jitoTipLamports,
                        }),
                    ],
                }).compileToV0Message();

                const tx2 = new VersionedTransaction(tx2Message);
                tx2.sign([activeWallet]);

                const tx1Base58 = bs58.encode(transaction.serialize());
                const tx2Base58 = bs58.encode(tx2.serialize());

                this.logger.log(
                    `[Jito] 🚀 Sending Bundle (Tip: ${jitoTipSol} SOL to ${randomTipAccount})...`,
                );

                try {
                    const bundleResponse = await axios.post(
                        jitoBlockEngineUrl,
                        {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'sendBundle',
                            params: [[tx1Base58, tx2Base58]],
                        },
                        { headers: { 'Content-Type': 'application/json' } },
                    );

                    if (bundleResponse.data?.error) {
                        // The block engine received the request but REJECTED the bundle
                        // (it will not land). This is a definitive pre-broadcast rejection —
                        // leave `broadcasted` false so the outer catch can safely retry
                        // rather than freezing the position on a non-existent in-flight tx.
                        throw new Error(
                            `Jito Bundle Error: ${JSON.stringify(bundleResponse.data.error)}`,
                        );
                    }

                    // IDEMPOTENCY: the bundle was accepted by the block engine → it is now
                    // on the wire. Only from here is a subsequent confirmation failure
                    // ambiguous, so mark broadcast AFTER acceptance (not before the send).
                    broadcasted = true;
                    this.logger.log(
                        `[Jito] 🎉 Bundle accepted! ID: ${bundleResponse.data?.result}`,
                    );
                    txid = bs58.encode(transaction.signatures[0]);
                } catch (e: unknown) {
                    // If axios.post ITSELF threw (not the bundle-error rethrow above) with an
                    // ambiguous transport failure (timeout / reset / 5xx), the bundle MAY
                    // already have reached the block engine — treat as broadcast so the
                    // caller reconciles on-chain instead of blind re-sending. A definitive
                    // pre-broadcast rejection (429 / structured error / bundle-error rethrow)
                    // leaves `broadcasted` false → safe to retry.
                    if (!broadcasted && isAmbiguousSendFailure(e)) {
                        broadcasted = true;
                    }
                    const errResponse =
                        e instanceof Error && 'response' in e
                            ? JSON.stringify(
                                  (e as { response?: { data?: unknown } }).response?.data,
                              )
                            : '';
                    const msg = e instanceof Error ? e.message : String(e);
                    this.logger.error(`[Jito] Bundle submission failed: ${msg} ${errResponse}`);
                    throw new Error(`Jito Submission Error: ${msg}`);
                }
            } else {
                // IDEMPOTENCY: sendRawTransaction({skipPreflight:false}) runs preflight
                // simulation THEN submission behind one await. A preflight/simulation
                // failure throws BEFORE the tx reaches the leader (definitively NOT
                // broadcast — safe to retry), whereas a transport timeout/reset MAY have
                // reached the leader (ambiguous — must not blind re-send). Marking
                // `broadcasted` true unconditionally BEFORE the send misclassified every
                // preflight rejection as post-broadcast, freezing a monitored SELL for the
                // full unconfirmed-TTL on a tx that never hit the wire. So: mark broadcast
                // only AFTER a successful send, and on a throw only when the failure is
                // genuinely ambiguous (see isAmbiguousSendFailure).
                try {
                    txid = await this.connection.sendRawTransaction(transaction.serialize(), {
                        skipPreflight: false,
                        preflightCommitment: 'confirmed',
                        maxRetries: 3,
                    });
                    broadcasted = true;
                } catch (sendErr) {
                    if (isAmbiguousSendFailure(sendErr)) {
                        broadcasted = true;
                    }
                    throw sendErr;
                }
            }

            this.logger.log(`[Jupiter] Transaction sent: ${txid}. Waiting confirmation...`);

            const fallbackBlockhash = hasSwapLastValidBlockHeight
                ? null
                : await this.connection.getLatestBlockhash('confirmed');
            const confirmation = await this.connection.confirmTransaction(
                {
                    signature: txid,
                    blockhash: fallbackBlockhash?.blockhash || confirmationBlockhash,
                    lastValidBlockHeight:
                        fallbackBlockhash?.lastValidBlockHeight || swapLastValidBlockHeight,
                },
                'confirmed',
            );

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            // 🛡️ AMBIL HARGA EKSEKUSI RIIL DARI BLOCKCHAIN
            let finalPrice = price;
            let totalFeesSol = 0;
            let actualSol =
                side === 'BUY' ? amount / 1_000_000_000 : quoteData.outAmount / 1_000_000_000;
            let actualTokens =
                side === 'BUY'
                    ? quoteData.outAmount / Math.pow(10, decimals)
                    : amount / Math.pow(10, decimals);

            try {
                const actualSwap = await this.getActualSwapDetails(
                    txid,
                    activeWallet.publicKey.toBase58(),
                    side === 'BUY' ? outputMint : inputMint,
                    jitoTipLamports,
                    side,
                );
                if (actualSwap) {
                    const solPrice =
                        side === 'SELL'
                            ? await this.getSolPriceOrNull('SELL')
                            : await this.getSolPrice();
                    totalFeesSol = actualSwap.totalFeesSol;
                    actualSol = actualSwap.cleanSolAmount ?? Math.abs(actualSwap.solChange);
                    actualTokens = Math.abs(actualSwap.tokenChange);
                    if (side === 'BUY') {
                        if (actualTokens > 0 && solPrice) {
                            finalPrice = (actualSol * solPrice) / actualTokens;
                            this.logger.log(
                                `[Jupiter] Actual BUY price calculated from on-chain balances: $${finalPrice.toFixed(8)} (Quote: $${price.toFixed(8)})`,
                            );
                        }
                    } else {
                        if (actualTokens > 0 && solPrice) {
                            finalPrice = (actualSol * solPrice) / actualTokens;
                            this.logger.log(
                                `[Jupiter] Actual SELL price calculated from on-chain balances: $${finalPrice.toFixed(8)} (Quote: $${price.toFixed(8)})`,
                            );
                        } else {
                            this.logger.warn(
                                `[Jupiter] Actual SELL SOL amount found but live SOL price unavailable. Keeping quote/fallback USD price.`,
                            );
                        }
                    }
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.error(
                    `[Jupiter] Failed to fetch actual swap details: ${msg}. Falling back to quote price.`,
                );
            }

            return {
                success: true,
                entryPrice: finalPrice || 0.00000001,
                txHash: txid,
                actualSol,
                actualTokens,
                totalFeesSol,
            };
        } catch (error) {
            if (error instanceof PriceAnomalyError) {
                this.logger.error(
                    `[Jupiter] Price anomaly for ${error.mint}: calculated=${error.calculatedPrice}, jupiter=${error.jupiterPrice}, deviation=${(error.deviation * 100).toFixed(2)}%`,
                );
                return {
                    success: false,
                    entryPrice: 0,
                    error: `price_anomaly:${error.mint}`,
                    txHash: undefined,
                };
            }
            const message = error instanceof Error ? error.message : String(error);
            const errorClass = classifyRpcError(error);

            // IDEMPOTENCY: the tx was already broadcast — do NOT recursively re-send.
            // Returning failure lets executeSell reconcile THIS EXACT tx on-chain before
            // any further attempt, so a swap that actually landed is not sold twice. The
            // deterministic signature is returned (not discarded) so the caller does not
            // have to rely on a raceable balance snapshot: within the tx validity window
            // the balance still shows the un-sold tokens, and a blind re-sell would
            // double-execute.
            if (broadcasted) {
                const confirmedOnChainFailure = message.startsWith('Transaction failed:');
                const retryableOnChainFailure =
                    confirmedOnChainFailure &&
                    (message.includes('6001') || /slippage/i.test(message));
                if (retryableOnChainFailure && retryCount < maxRetries - 1) {
                    const waitTime = Math.min(1000 * (retryCount + 1), 3000);
                    this.logger.warn(
                        `[Jupiter] ${side} was definitively rejected on-chain after broadcast. ` +
                            `Refreshing quote and retrying in ${waitTime}ms (attempt ${retryCount + 2}/${maxRetries}).`,
                    );
                    await new Promise((res) => setTimeout(res, waitTime));
                    return this.executeJupiterSwap(
                        inputMint,
                        outputMint,
                        amount,
                        side,
                        buyAmountUSD,
                        retryCount + 1,
                        customSlippageBps,
                        priorityFeeLamports,
                        activeWallet,
                        dryRun,
                        route,
                        errorClass,
                        buySignal,
                    );
                }
                if (confirmedOnChainFailure) {
                    return {
                        success: false,
                        entryPrice: 0,
                        error: `swap_failed:${message}`,
                        txHash: undefined,
                        jitoTipLamports,
                    };
                }
                this.logger.error(
                    `[Jupiter] ${side} failed AFTER broadcast (${errorClass}): ${message}. ` +
                        `Not re-sending in-call to avoid double-execution; returning signature ` +
                        `${broadcastSignature ?? 'unknown'} for on-chain reconciliation by the caller.`,
                );
                return {
                    success: false,
                    entryPrice: 0,
                    error: `post_broadcast_unconfirmed:${message}`,
                    txHash: broadcastSignature,
                    jitoTipLamports,
                };
            }

            if (retryCount < maxRetries - 1) {
                // Rate-limit-aware failover: rotate to a backup RPC endpoint on 429 so the
                // retry does not hit the same throttled provider (requirement 2).
                if (errorClass === 'RATE_LIMIT') {
                    this.rotateRpcConnection();
                }
                // Bounded exponential backoff + jitter on 429/5xx/timeout (requirement 1),
                // replacing the previous flat linear 1000*(n+1) delay that could compound
                // rate-limiting. Non-transport errors keep retrying too (no regression) but
                // with the same jittered backoff.
                //
                // Exception: JupiterLimiter already ran its own SELL-priority 429 backoff
                // (up to SELL_MAX_ATTEMPTS attempts, ~1s+2s) before rejecting with this
                // marker (jupiter-limiter.ts). Applying a FULL fresh exponential backoff here
                // on top, independently at each of the SELL's several dispatch points
                // (quote/fallback-price/swap), would stack two uncoordinated retry layers for
                // the SAME rate-limit event and compound worst-case tail latency. Skip this
                // layer's wait in that specific case -- the limiter already paid it.
                const sellRetriesExhaustedInLimiter = Boolean(
                    (error as { jupiterSellRetriesExhausted?: boolean } | null | undefined)
                        ?.jupiterSellRetriesExhausted,
                );
                const backoffOpts = { baseMs: 1000, maxMs: 8000, jitterRatio: 0.5 };
                const waitTime = sellRetriesExhaustedInLimiter
                    ? 0
                    : isRetryableRpcError(error)
                      ? computeBackoffDelay(retryCount, backoffOpts)
                      : 1000 * (retryCount + 1);
                this.logger.log(
                    `[Jupiter] Retrying in ${waitTime}ms (class=${errorClass}, attempt ${retryCount + 2}/${maxRetries})...`,
                );
                await new Promise((res) => setTimeout(res, waitTime));
                return this.executeJupiterSwap(
                    inputMint,
                    outputMint,
                    amount,
                    side,
                    buyAmountUSD,
                    retryCount + 1,
                    customSlippageBps,
                    priorityFeeLamports,
                    activeWallet,
                    dryRun,
                    route,
                    errorClass,
                    buySignal,
                );
            }
            return { success: false, entryPrice: 0, error: message, txHash: undefined };
        }
    }

    private async getActualSwapDetails(
        txHash: string,
        wallet: string,
        tokenMint: string,
        bundleTipLamports = 0,
        side: 'BUY' | 'SELL' = 'BUY',
    ): Promise<{
        solChange: number;
        tokenChange: number;
        cleanSolAmount: number | null;
        totalFeesSol: number;
    } | null> {
        let tx: ParsedTransactionWithMeta | null = null;
        for (let i = 0; i < 5; i++) {
            try {
                tx = await this.connection.getParsedTransaction(txHash, {
                    maxSupportedTransactionVersion: 0,
                });
                if (tx) break;
            } catch (err) {
                this.logger.warn(
                    `Failed to parse transaction ${txHash} on attempt ${i + 1}: ${err}`,
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        if (!tx) return null;

        // Cari perubahan saldo SOL wallet
        const walletIndex = tx.transaction.message.accountKeys.findIndex(
            (k) => k.pubkey.toBase58() === wallet,
        );
        let solChange = 0;
        let rawSolDeltaLamports = 0;
        if (walletIndex !== -1) {
            const preSol = tx.meta?.preBalances[walletIndex] ?? 0;
            const postSol = tx.meta?.postBalances[walletIndex] ?? 0;
            rawSolDeltaLamports = Math.abs(postSol - preSol);
            solChange = (postSol - preSol) / 1_000_000_000;
        }

        // Cari perubahan saldo Token wallet
        const preTokenAmount =
            tx.meta?.preTokenBalances?.find((b) => b.owner === wallet && b.mint === tokenMint)
                ?.uiTokenAmount.uiAmount ?? 0;
        const postTokenAmount =
            tx.meta?.postTokenBalances?.find((b) => b.owner === wallet && b.mint === tokenMint)
                ?.uiTokenAmount.uiAmount ?? 0;
        const tokenChange = postTokenAmount - preTokenAmount;

        const networkFeeLamports = tx.meta?.fee || 0;
        const rentDeltaLamports = this.calculateWalletTokenAccountRentDelta(tx, wallet, tokenMint);
        const { cleanSolAmount, totalFeesSol } = calculateCleanSwapSolAmount(
            rawSolDeltaLamports,
            networkFeeLamports,
            rentDeltaLamports,
            bundleTipLamports,
            side,
        );

        if (cleanSolAmount === null) {
            this.logger.error(
                `[SwapDetails] Invalid clean SOL amount. raw=${rawSolDeltaLamports}, feesSol=${totalFeesSol}. Falling back to quote price.`,
            );
        }

        return {
            solChange,
            tokenChange,
            cleanSolAmount,
            totalFeesSol,
        };
    }

    private calculateWalletTokenAccountRentDelta(
        tx: ParsedTransactionWithMeta,
        wallet: string,
        tokenMint: string,
    ): number {
        const preBalances = tx.meta?.preBalances || [];
        const postBalances = tx.meta?.postBalances || [];
        const accountIndexes = new Set<number>();

        for (const balance of tx.meta?.preTokenBalances || []) {
            if (balance.owner === wallet && balance.mint === tokenMint) {
                accountIndexes.add(balance.accountIndex);
            }
        }
        for (const balance of tx.meta?.postTokenBalances || []) {
            if (balance.owner === wallet && balance.mint === tokenMint) {
                accountIndexes.add(balance.accountIndex);
            }
        }

        let rentDelta = 0;
        for (const accountIndex of accountIndexes) {
            const delta = Math.abs(
                (postBalances[accountIndex] || 0) - (preBalances[accountIndex] || 0),
            );
            if (delta > 0 && delta <= 20_000_000) {
                rentDelta += delta;
            }
        }

        return rentDelta;
    }

    private async fetchTokenSymbol(tokenMint: string): Promise<string> {
        try {
            // Try DexScreener first
            const response = await DexLimiter.get<{
                pairs: Array<{ baseToken?: { symbol?: string } }>;
            }>(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
                timeout: 3000,
                httpsAgent: this.httpsAgent,
            });
            const dexSymbol = selectBestDexScreenerPair(response.data?.pairs, tokenMint)?.baseToken
                ?.symbol;
            if (dexSymbol) return `$${dexSymbol}`;

            return 'UNKNOWN';
        } catch {
            return 'UNKNOWN';
        }
    }

    async getTokenDecimals(tokenMint: string): Promise<number> {
        return this.getTokenDecimalsStrict(tokenMint);
    }

    async getTokenDecimalsStrict(tokenMint: string): Promise<number> {
        const cached = this.decimalsCache.get(tokenMint);
        if (cached !== undefined) return cached;

        if (tokenMint.toLowerCase().endsWith('pump')) {
            this.decimalsCache.set(tokenMint, 6);
            return 6;
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const { PublicKey } = await import('@solana/web3.js');
                const { getMint } = await import('@solana/spl-token');
                const mintPublicKey = new PublicKey(tokenMint);
                const accountInfo = await this.connection.getAccountInfo(mintPublicKey);
                if (!accountInfo) throw new Error('Mint account not found');
                const mintInfo = await getMint(
                    this.connection,
                    mintPublicKey,
                    undefined,
                    accountInfo.owner,
                );
                const decimals = mintInfo.decimals;
                if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
                    throw new Error(`Invalid decimals value: ${decimals}`);
                }
                this.decimalsCache.set(tokenMint, decimals);
                return decimals;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `Failed to fetch decimals for ${tokenMint} (attempt ${attempt}/3): ${msg}`,
                );
                if (attempt < 3) {
                    await new Promise((res) => setTimeout(res, 200 * attempt));
                }
            }
        }

        throw new TokenDecimalsUnavailableError(tokenMint);
    }

    private async getTokenDecimalsLegacyUnused(tokenMint: string): Promise<number> {
        // 💊 PUMP.FUN DETECTOR: Koin pump.fun selalu 6 desimal
        if (tokenMint.toLowerCase().endsWith('pump')) {
            return 6;
        }

        try {
            const { PublicKey } = await import('@solana/web3.js');
            const { getMint } = await import('@solana/spl-token');
            const mintPublicKey = new PublicKey(tokenMint);
            const accountInfo = await this.connection.getAccountInfo(mintPublicKey);
            const programId = accountInfo ? accountInfo.owner : undefined;
            const mintInfo = await getMint(this.connection, mintPublicKey, undefined, programId);
            return mintInfo.decimals;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to fetch decimals for ${tokenMint}: ${msg}.`);
            throw new TokenDecimalsUnavailableError(tokenMint);
        }
    }

    /**
     * Fallback price fetcher using Jupiter Price API.
     * Used when sell price calculation produces impossible values.
     */
    private async getSellPriceFallback(tokenMint: string): Promise<number | null> {
        try {
            // Same host/endpoint family as getSolPriceOrNull, and called unconditionally on
            // every SELL — must go through JupiterLimiter (not raw axios) so it is spaced
            // and prioritized against the rest of the Jupiter traffic instead of bypassing
            // the limiter's throttling entirely. 'SELL' priority matches the quote/swap
            // calls for this same SELL flow (protective, not informational).
            const response = await JupiterLimiter.get<
                Record<string, { usdPrice?: number } | undefined>
            >(`https://api.jup.ag/price/v3?ids=${tokenMint}`, 'SELL', {
                timeout: 5000,
                headers: { 'x-api-key': this.jupiterApiKey },
                httpsAgent: this.httpsAgent,
            });
            const data = response.data;
            const price = data?.[tokenMint]?.usdPrice;
            return price && !isNaN(price) ? price : null;
        } catch {
            return null;
        }
    }

    async getTokenBalance(walletAddress: string, tokenMint: string): Promise<number | null> {
        try {
            const accounts = await this.connection.getParsedTokenAccountsByOwner(
                new (await import('@solana/web3.js')).PublicKey(walletAddress),
                { mint: new (await import('@solana/web3.js')).PublicKey(tokenMint) },
            );

            return accounts.value.reduce((sum, account) => {
                const amount = account.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
                return sum + amount;
            }, 0);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to get token balance for ${walletAddress}: ${msg}`);
            return null; // Return null biar bot tahu ini error API, bukan saldo 0
        }
    }

    async getSolPrice(): Promise<number> {
        // Serve a still-fresh cached price without touching Jupiter. PriceMonitorService
        // evaluates every open position roughly twice a second and each evaluation needs the
        // SOL price, so calling the API every time burned the shared Jupiter budget on purely
        // informational reads — to the point where a protective SELL swap was itself getting
        // 429'd. SOL_PRICE_CACHE_MAX_AGE_MS only ever applied after a failure, so it never
        // prevented any of those calls.
        const refreshIntervalMs = Math.max(
            0,
            this.getNumberConfig('SOL_PRICE_REFRESH_INTERVAL_MS', 2_000),
        );
        const cacheAgeMs =
            this.lastKnownSolPriceAt === null ? null : Date.now() - this.lastKnownSolPriceAt;
        if (
            this.lastKnownSolPriceUsd !== null &&
            cacheAgeMs !== null &&
            cacheAgeMs < refreshIntervalMs
        ) {
            return this.lastKnownSolPriceUsd;
        }

        const livePrice = await this.getSolPriceOrNull();
        const now = Date.now();
        if (livePrice !== null) {
            this.lastKnownSolPriceUsd = livePrice;
            this.lastKnownSolPriceAt = now;
            return livePrice;
        }

        const maxCacheAgeMs = Math.max(
            0,
            this.getNumberConfig('SOL_PRICE_CACHE_MAX_AGE_MS', 60_000),
        );
        const cachedPrice = resolveUsableSolPrice(
            null,
            this.lastKnownSolPriceUsd,
            this.lastKnownSolPriceAt,
            now,
            maxCacheAgeMs,
        );
        if (cachedPrice !== null) {
            this.logger.warn(
                'SOL price API unavailable; using ' +
                    ((now - (this.lastKnownSolPriceAt ?? now)) / 1000).toFixed(1) +
                    's-old cached price USD ' +
                    cachedPrice.toFixed(2) +
                    '.',
            );
            return cachedPrice;
        }

        throw new Error('SOL price unavailable: no live price or fresh cached value');
    }

    private async getSolPriceOrNull(priority: JupiterPriority = 'BUY'): Promise<number | null> {
        try {
            // Default 'BUY': informational-only call sites (not protective like a SELL)
            // stay routed through the BUY lane so they never compete with SELL requests for
            // the shared Jupiter API budget. Call sites that are themselves part of a SELL's
            // own critical path must pass 'SELL' explicitly (see call site comments).
            const response = await JupiterLimiter.get(
                `https://api.jup.ag/price/v3?ids=${WRAPPED_SOL_MINT}`,
                priority,
                {
                    timeout: 3000,
                    headers: { 'x-api-key': this.jupiterApiKey },
                    httpsAgent: this.httpsAgent,
                },
            );
            const data = response.data as Record<string, { usdPrice?: number } | undefined> | null;
            const price = Number(data?.[WRAPPED_SOL_MINT]?.usdPrice ?? 0);
            return Number.isFinite(price) && price > 0 ? price : null;
        } catch {
            return null;
        }
    }

    /**
     * Manual Trade Handlers for Telegram
     */
    async handleManualBuy(
        tokenMint: string,
        amountUSD: number,
        chatId?: string,
    ): Promise<{ success: boolean; message: string }> {
        this.logger.log(`[Manual Buy] Initiating buy for ${tokenMint} with $${amountUSD}`);
        return this.attemptBuy(tokenMint, undefined, amountUSD, undefined, chatId);
    }

    async handleManualSell(
        tokenMint: string,
        percentage: number,
        chatId?: string,
    ): Promise<{ success: boolean; message: string }> {
        const chatRecord = chatId ? await this.telegramWorkspace.getChatById(chatId) : null;
        const trade = await this.prismaService.trade.findFirst({
            where: {
                tokenMint,
                status: 'OPEN',
                mode: 'LIVE',
                ...(chatRecord?.id ? { telegramChatId: chatRecord.id } : {}),
            },
        });

        if (trade) {
            // 'SELL' priority: this manual-sell authorization path gates executeSell() right
            // below, so the price lookup itself must not queue behind the (lower-priority) BUY
            // lane — the default priority ('BUY') would add avoidable queueing latency here.
            // Only fetched in this branch: the untracked-token (else) branch below never uses
            // currentPrice, so fetching it unconditionally would waste a protected SELL-lane slot.
            const currentPrice = await this.reportingService.fetchCurrentPrice(tokenMint, 'SELL');
            if (!currentPrice) {
                return { success: false, message: 'Failed to fetch current price.' };
            }
            await this.executeSell(trade.id, currentPrice, 'MANUAL_SELL', percentage, true);
            return {
                success: true,
                message: `Sell order for ${(percentage * 100).toFixed(0)}% executed.`,
            };
        } else {
            // Manual sell for token not in DB
            if (!chatId) {
                return { success: false, message: 'Chat wallet is required for manual sell.' };
            }
            const wallet = await this.getWallet(chatId);
            const actualBalance = await this.getTokenBalance(
                wallet.publicKey.toBase58(),
                tokenMint,
            );
            if (actualBalance === null || actualBalance <= 0)
                return { success: false, message: 'Zero or invalid balance in wallet.' };

            const decimals = await this.getTokenDecimals(tokenMint);
            const amountInLamports = Math.floor(
                actualBalance * percentage * Math.pow(10, decimals),
            );

            const { success, error, txHash } = await this.executeJupiterSwap(
                tokenMint,
                WRAPPED_SOL_MINT,
                amountInLamports,
                'SELL',
                undefined,
                0,
                undefined,
                undefined,
                wallet,
                false,
            );

            if (success) {
                return {
                    success: true,
                    message: `Manual sell for ${(percentage * 100).toFixed(0)}% (${tokenMint}) executed.`,
                };
            }
            // A manual sell for an untracked token has no tick loop or DB row to reconcile
            // against, but a broadcast-but-unconfirmed sell MUST NOT be reported as a plain
            // failure with its signature discarded: the tx may still land. Surface the exact
            // signature so a re-sell is balance-checked (the wallet balance is re-read on the
            // next attempt at the top of this path) and the operator can reconcile on-chain.
            if (
                typeof error === 'string' &&
                error.startsWith('post_broadcast_unconfirmed') &&
                txHash
            ) {
                this.logger.warn(
                    `[ManualSell] UNCONFIRMED sell token=${tokenMint} tx=${txHash}. It may still ` +
                        `land; a retry re-reads the live balance before re-selling.`,
                );
                return {
                    success: false,
                    message:
                        `Manual sell was broadcast but not confirmed (tx ${txHash}). It may still ` +
                        `land — re-check the wallet balance before retrying to avoid double-selling.`,
                };
            }
            return { success: false, message: error || 'Swap failed' };
        }
    }

    async sendSolanaToAddress(
        chatId: string,
        destinationAddress: string,
        amountMode: 'percent' | 'usd',
        amountValue: number,
    ): Promise<{ success: boolean; message: string }> {
        if (!chatId) {
            return { success: false, message: 'Chat ID is required for SOL transfer.' };
        }

        const chatRecord = await this.telegramWorkspace.getChatById(chatId);
        if (!chatRecord) {
            return { success: false, message: 'Telegram chat not registered. Send /start first.' };
        }

        const allowedChatIds = this.getWithdrawAllowedChatIds();
        const preflightGuard = validateWithdrawAccess({
            chatId,
            withdrawalsEnabled: this.isWithdrawEnabled(),
            allowedChatIds,
            walletPublicKey: chatRecord.walletVault?.publicKey,
        });
        if (!preflightGuard.allowed) {
            return this.denyWithdraw(chatId, preflightGuard.reason);
        }

        if (!destinationAddress || !this.isValidSolanaAddress(destinationAddress)) {
            return { success: false, message: 'Invalid destination Solana address.' };
        }

        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return { success: false, message: 'Invalid transfer amount.' };
        }

        const wallet = await this.getWallet(chatId);
        const signerGuard = validateWithdrawAccess({
            chatId,
            withdrawalsEnabled: true,
            allowedChatIds,
            walletPublicKey: chatRecord.walletVault?.publicKey,
            signerPublicKey: wallet.publicKey.toBase58(),
        });
        if (!signerGuard.allowed) {
            return this.denyWithdraw(chatId, signerGuard.reason);
        }

        const recipient = new PublicKey(destinationAddress);
        const balanceLamports = await this.connection.getBalance(wallet.publicKey);
        const balanceSol = balanceLamports / 1_000_000_000;
        const reserveSol = this.getNumberConfig('WITHDRAWAL_RESERVE_SOL', 0.005);
        const spendableSol = Math.max(balanceSol - reserveSol, 0);
        const solPrice = amountMode === 'usd' ? await this.getSolPrice() : null;
        const transferSol =
            amountMode === 'percent' ? spendableSol * amountValue : amountValue / (solPrice || 150);

        if (!Number.isFinite(transferSol) || transferSol <= 0) {
            return { success: false, message: 'Calculated transfer amount is invalid.' };
        }

        if (transferSol > spendableSol) {
            return {
                success: false,
                message: `Insufficient SOL balance. Have ${balanceSol.toFixed(4)} SOL, spendable after reserve is ${spendableSol.toFixed(4)} SOL.`,
            };
        }

        const lamports = Math.floor(transferSol * 1_000_000_000);
        if (lamports <= 0) {
            return { success: false, message: 'Transfer amount rounds down to zero.' };
        }

        const withdrawal = await this.prismaService.telegramWithdrawal.create({
            data: {
                telegramChatId: chatRecord.id,
                destinationAddress,
                amountMode: amountMode === 'percent' ? 'PERCENT' : 'USD',
                requestedAmount: amountValue,
                amountTransferredSol: transferSol,
                balanceBeforeSol: balanceSol,
                status: 'PENDING',
            },
        });

        try {
            const blockhash = await this.connection.getLatestBlockhash('confirmed');
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: wallet.publicKey,
                    toPubkey: recipient,
                    lamports,
                }),
            );
            transaction.feePayer = wallet.publicKey;
            transaction.recentBlockhash = blockhash.blockhash;
            transaction.sign(wallet);

            const txid = await this.connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
                maxRetries: 3,
            });

            const confirmation = await this.connection.confirmTransaction(
                {
                    signature: txid,
                    blockhash: blockhash.blockhash,
                    lastValidBlockHeight: blockhash.lastValidBlockHeight,
                },
                'confirmed',
            );

            if (confirmation.value.err) {
                await this.prismaService.telegramWithdrawal.update({
                    where: { id: withdrawal.id },
                    data: {
                        status: 'FAILED',
                        errorMessage: `Transfer failed: ${JSON.stringify(confirmation.value.err)}`,
                        balanceAfterSol: await this.connection
                            .getBalance(wallet.publicKey)
                            .then((lamportsAfter) => lamportsAfter / 1_000_000_000),
                    },
                });
                return {
                    success: false,
                    message: `Transfer failed: ${JSON.stringify(confirmation.value.err)}`,
                };
            }

            const balanceAfterSol = await this.connection
                .getBalance(wallet.publicKey)
                .then((lamportsAfter) => lamportsAfter / 1_000_000_000);
            await this.prismaService.telegramWithdrawal.update({
                where: { id: withdrawal.id },
                data: {
                    status: 'SUCCESS',
                    txHash: txid,
                    balanceAfterSol,
                },
            });

            return {
                success: true,
                message: `Sent ${transferSol.toFixed(4)} SOL to ${destinationAddress}. Tx: ${txid}`,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[SOL Transfer] Failed for chat ${chatId}: ${msg}`);
            await this.prismaService.telegramWithdrawal.update({
                where: { id: withdrawal.id },
                data: {
                    status: 'FAILED',
                    errorMessage: msg,
                    balanceAfterSol: await this.connection
                        .getBalance(wallet.publicKey)
                        .then((lamportsAfter) => lamportsAfter / 1_000_000_000)
                        .catch(() => null),
                },
            });
            return { success: false, message: `Transfer failed: ${msg}` };
        }
    }

    async getWalletHoldings(
        walletAddress: string,
    ): Promise<Array<{ mint: string; symbol: string; balance: number }>> {
        try {
            const { PublicKey } = await import('@solana/web3.js');
            if (!walletAddress) {
                throw new Error('Wallet address is required to inspect holdings.');
            }
            const resolvedWalletAddress = walletAddress;
            const accounts = await this.connection.getParsedTokenAccountsByOwner(
                new PublicKey(resolvedWalletAddress),
                { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
            );

            const holdings: Array<{ mint: string; symbol: string; balance: number }> = [];

            for (const account of accounts.value) {
                const mint = account.account.data.parsed.info.mint;
                const balance = account.account.data.parsed.info.tokenAmount.uiAmount;

                if (balance > 0) {
                    // Try to find symbol from DB first
                    const trade = await this.prismaService.trade.findFirst({
                        where: { tokenMint: mint },
                    });
                    const symbol = trade?.symbol || (await this.fetchTokenSymbol(mint));

                    // Filter out dust (very small values)
                    const dustThreshold = Number.parseFloat(
                        this.configService.get<string>('TRADE_DUST_THRESHOLD', '0.000001'),
                    );
                    if (balance > dustThreshold) {
                        holdings.push({ mint, symbol, balance });
                    }
                }
            }

            return holdings;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to fetch wallet holdings: ${msg}`);
            return [];
        }
    }

    private isValidSolanaAddress(address: string): boolean {
        try {
            new PublicKey(address);
            return true;
        } catch {
            return false;
        }
    }

    async getWalletHoldingsForChat(
        chatId: string,
    ): Promise<Array<{ mint: string; symbol: string; balance: number }>> {
        const wallet = await this.getWallet(chatId);
        const [onChainHoldings, chatRecord] = await Promise.all([
            this.getWalletHoldings(wallet.publicKey.toBase58()),
            this.telegramWorkspace.getChatById(chatId),
        ]);

        const holdingsByMint = new Map<string, { mint: string; symbol: string; balance: number }>();

        for (const holding of onChainHoldings) {
            holdingsByMint.set(holding.mint, holding);
        }

        if (chatRecord?.id) {
            const openTrades = await this.prismaService.trade.findMany({
                where: {
                    telegramChatId: chatRecord.id,
                    status: 'OPEN',
                    mode: 'LIVE',
                },
                orderBy: { updatedAt: 'desc' },
            });

            for (const trade of openTrades) {
                if (holdingsByMint.has(trade.tokenMint)) continue;

                let estimatedBalance = 0;
                try {
                    const currentPrice = await this.reportingService.fetchCurrentPrice(
                        trade.tokenMint,
                    );
                    if (currentPrice && trade.entryPrice > 0) {
                        const estimatedUsdValue =
                            trade.amountInSol * (trade.solPriceAtEntry || currentPrice);
                        estimatedBalance = estimatedUsdValue / trade.entryPrice;
                    }
                } catch {
                    estimatedBalance = 0;
                }

                holdingsByMint.set(trade.tokenMint, {
                    mint: trade.tokenMint,
                    symbol: trade.symbol || 'UNKNOWN',
                    balance: estimatedBalance,
                });
            }
        }

        return Array.from(holdingsByMint.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
    }

    async getPortfolioForChat(chatId: string): Promise<
        Array<{
            mint: string;
            symbol: string;
            balance: number;
            entryPriceUsd?: number;
            currentPriceUsd?: number;
            entryPriceSol?: number;
            currentPriceSol?: number;
            entryValueUsd?: number;
            valueUsd?: number;
            entryValueSol?: number;
            valueSol?: number;
            pnlUsd?: number;
            pnlSol?: number;
            pnlPercent?: number;
            solPriceAtEntry?: number;
            currentSolPriceUsd?: number;
            source: 'ON_CHAIN';
        }>
    > {
        const wallet = await this.getWallet(chatId);
        const walletAddress = wallet.publicKey.toBase58();
        const [onChainHoldings, chatRecord] = await Promise.all([
            this.getWalletHoldings(walletAddress),
            this.telegramWorkspace.getChatById(chatId),
        ]);

        const holdingsByMint = new Map<string, { mint: string; symbol: string; balance: number }>();
        for (const holding of onChainHoldings) {
            const existing = holdingsByMint.get(holding.mint);
            holdingsByMint.set(holding.mint, {
                mint: holding.mint,
                symbol: existing?.symbol || holding.symbol,
                balance: (existing?.balance || 0) + holding.balance,
            });
        }

        const currentSolPriceUsd = await this.getSolPrice();
        const openTradeMetaByMint = new Map<
            string,
            {
                entryPriceUsd?: number;
                entryValueUsd?: number;
                entryValueSol?: number;
                solPriceAtEntry?: number;
                symbol?: string;
            }
        >();
        if (chatRecord?.id) {
            const openTrades = await this.prismaService.trade.findMany({
                where: {
                    telegramChatId: chatRecord.id,
                    status: 'OPEN',
                    mode: 'LIVE',
                },
                orderBy: { updatedAt: 'desc' },
            });

            for (const trade of openTrades) {
                if (openTradeMetaByMint.has(trade.tokenMint)) continue;
                openTradeMetaByMint.set(trade.tokenMint, {
                    entryPriceUsd: trade.entryPrice || undefined,
                    entryValueUsd:
                        trade.entryValueUsd !== null && trade.entryValueUsd !== undefined
                            ? trade.entryValueUsd
                            : undefined,
                    entryValueSol: trade.amountInSol || undefined,
                    solPriceAtEntry: trade.solPriceAtEntry || undefined,
                    symbol: trade.symbol || undefined,
                });
            }
        }

        const dustThreshold = Number.parseFloat(
            this.configService.get<string>('TRADE_DUST_THRESHOLD', '0.000001'),
        );
        for (const [mint, meta] of openTradeMetaByMint.entries()) {
            if (holdingsByMint.has(mint)) continue;

            const balance = await this.getTokenBalance(walletAddress, mint);
            if (balance === null || balance <= dustThreshold) continue;

            holdingsByMint.set(mint, {
                mint,
                symbol: meta.symbol || 'UNKNOWN',
                balance,
            });
        }

        const portfolio = await Promise.all(
            Array.from(holdingsByMint.values()).map(async (holding) => {
                const meta = openTradeMetaByMint.get(holding.mint);
                const currentPriceUsd = await this.reportingService.fetchCurrentPrice(holding.mint);
                const valueUsd =
                    currentPriceUsd && holding.balance > 0
                        ? currentPriceUsd * holding.balance
                        : undefined;
                const valueSol =
                    valueUsd !== undefined && currentSolPriceUsd > 0
                        ? valueUsd / currentSolPriceUsd
                        : undefined;
                const pnlUsd =
                    valueUsd !== undefined && meta?.entryValueUsd !== undefined
                        ? valueUsd - meta.entryValueUsd
                        : undefined;
                const pnlSol =
                    valueSol !== undefined && meta?.entryValueSol !== undefined
                        ? valueSol - meta.entryValueSol
                        : undefined;
                const pnlPercent =
                    pnlSol !== undefined &&
                    meta?.entryValueSol !== undefined &&
                    meta.entryValueSol > 0
                        ? (pnlSol / meta.entryValueSol) * 100
                        : undefined;

                return {
                    mint: holding.mint,
                    symbol: meta?.symbol || holding.symbol,
                    balance: holding.balance,
                    entryPriceUsd: meta?.entryPriceUsd,
                    currentPriceUsd: currentPriceUsd || undefined,
                    entryPriceSol:
                        meta?.entryPriceUsd !== undefined &&
                        meta?.solPriceAtEntry !== undefined &&
                        meta.solPriceAtEntry > 0
                            ? meta.entryPriceUsd / meta.solPriceAtEntry
                            : undefined,
                    currentPriceSol:
                        currentPriceUsd && currentSolPriceUsd > 0
                            ? currentPriceUsd / currentSolPriceUsd
                            : undefined,
                    entryValueUsd: meta?.entryValueUsd,
                    valueUsd,
                    entryValueSol: meta?.entryValueSol,
                    valueSol,
                    pnlUsd,
                    pnlSol,
                    pnlPercent,
                    solPriceAtEntry: meta?.solPriceAtEntry,
                    currentSolPriceUsd,
                    source: 'ON_CHAIN' as const,
                };
            }),
        );

        return portfolio.sort((a, b) => a.symbol.localeCompare(b.symbol));
    }
    async getWalletBalanceForChat(
        chatId: string,
    ): Promise<{ publicKey: string; balanceSol: number; balanceUsd: number }> {
        const wallet = await this.getWallet(chatId);
        const balanceLamports = await this.connection.getBalance(wallet.publicKey);
        const balanceSol = balanceLamports / 1_000_000_000;
        const solPrice = await this.getSolPrice();
        return {
            publicKey: wallet.publicKey.toBase58(),
            balanceSol,
            balanceUsd: balanceSol * solPrice,
        };
    }

    async getWinRateForChat(chatId: string): Promise<{
        total: number;
        wins: number;
        losses: number;
        winRate: number;
    }> {
        const chatRecord = await this.telegramWorkspace.getChatById(chatId);
        if (!chatRecord) {
            return { total: 0, wins: 0, losses: 0, winRate: 0 };
        }

        const trades = await this.prismaService.trade.findMany({
            where: { telegramChatId: chatRecord.id, status: 'CLOSED', mode: 'LIVE' },
            select: { profitUsd: true, totalFeesSol: true, solPriceAtEntry: true },
        });
        const total = trades.length;
        const wins = trades.filter((trade) => computeNetProfitUsd(trade) > 0).length;
        const losses = total - wins;
        const winRate = total > 0 ? (wins / total) * 100 : 0;

        return { total, wins, losses, winRate };
    }
}
