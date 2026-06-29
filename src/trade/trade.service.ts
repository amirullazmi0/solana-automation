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
import { DexLimiter } from '../common/dex-limiter';
import { computeNetProfitUsd } from '../common/fee-utils';
import { TokenMetadata, TradeExecutionPayload } from '../dto/analyzer.dto';
import { PrismaService } from '../prisma/prisma.service';
import { BuyExecutionOptions, BuyRiskConfig, BuyRiskMetrics, TradeAuditFields } from '../dto/trade.dto';
import { ReportingService } from '../reporting/reporting.service';
import { TelegramWorkspaceService } from '../telegram/telegram-workspace.service';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';


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
    if (text.includes('daily_max_loss') || text.includes('daily max loss')) return 'risk_daily_max_loss';
    if (text.includes('consecutive')) return 'risk_max_consecutive_losses';
    if (text.includes('disabled_until') || text.includes('disabled until')) return 'risk_disabled_until';
    if (text.includes('slot_limit') || text.includes('slot_guard') || text.includes('slot guard')) return 'slot_guard';
    if (text.includes('capital_guard') || text.includes('capital guard')) return 'capital_guard';
    if (text.includes('insufficient_balance') || text.includes('balance_guard') || text.includes('insufficient sol balance') || text.includes('balance guard')) return 'balance_guard';
    if (text.includes('invalid_price_or_amount')) return 'invalid_price_or_amount';
    if (text.includes('already_open_trade')) return 'already_open_trade';
    if (text.includes('cooldown')) return 'cooldown';
    if (text.includes('price_impact_guard') || text.includes('price impact')) return 'price_impact_guard';
    if (text.includes('quote') || text.includes('decimals_unavailable') || text.includes('cancelled_decimals_unavailable')) return 'jupiter_quote_failed';
    if (text.includes('confirm')) return 'confirmation_failed';
    if (text.includes('swap')) return 'swap_failed';
    return rawReason || 'unknown_execution_failure';
}

function normalizeBuyFailureStage(reason: string): 'PRE_SWAP' | 'QUOTE' | 'SWAP' | 'CONFIRMATION' {
    const normalized = normalizeBuyFailureReason(reason);
    if ([
        'risk_max_drawdown',
        'risk_daily_max_loss',
        'risk_max_consecutive_losses',
        'risk_disabled_until',
        'capital_guard',
        'slot_guard',
        'balance_guard',
        'invalid_price_or_amount',
        'already_open_trade',
        'cooldown',
    ].includes(normalized)) {
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
        this.connection = new Connection(this.getSolanaRpcUrl(), 'confirmed');
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';

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

    private getSolanaRpcUrl(): string {
        const heliusRpcUrl = this.configService.get<string>('SOLANA_RPC_URL');
        if (heliusRpcUrl && heliusRpcUrl.trim()) {
            return heliusRpcUrl.trim();
        }

        const fallbackRpcUrl = this.configService.get<string>('RPC_ENDPOINT');
        if (fallbackRpcUrl && fallbackRpcUrl.trim()) {
            return fallbackRpcUrl.trim();
        }

        return 'https://api.mainnet-beta.solana.com';
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

    private applyFinalSize(
        baseSizeUsd: number,
        route?: TradeRoute,
        aiMultiplier?: number,
    ): number {
        const routeMultiplier = this.getRouteSizeMultiplier(route);
        return calculateFinalBuySizeUsd(baseSizeUsd, routeMultiplier, aiMultiplier);
    }

    private getNumberConfig(key: string, fallback: number): number {
        const value = Number.parseFloat(this.configService.get<string>(key, String(fallback)));
        return Number.isFinite(value) ? value : fallback;
    }

    private calculateDynamicReserveUsd(balanceUsd: number): number {
        const reserveRatio = Math.min(
            Math.max(this.getNumberConfig('DYNAMIC_RESERVE_RATIO', 0.2), 0),
            0.95,
        );
        const minReserveUsd = Math.max(this.getNumberConfig('MIN_RESERVE_USD', 1), 0);
        const maxReserveUsd = Math.max(this.getNumberConfig('MAX_RESERVE_USD', 10), minReserveUsd);
        const percentageReserve = balanceUsd * reserveRatio;
        return Math.min(Math.max(percentageReserve, minReserveUsd), maxReserveUsd);
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
    }    private getStartOfDayUtc(): Date {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        return d;
    }

    private async getBuyRiskMetrics(
        maxConsecutiveLosses: number,
        route?: TradeRoute,
        riskPnlStartAt?: Date | null,
        consecutiveLookbackHours = 3,
    ): Promise<BuyRiskMetrics> {
        const dayStart = this.getStartOfDayUtc();
        const effectiveDailyStart =
            riskPnlStartAt && riskPnlStartAt.getTime() > dayStart.getTime()
                ? riskPnlStartAt
                : dayStart;
        const baseWhere = riskPnlStartAt
            ? { status: 'CLOSED' as const, mode: 'LIVE' as const, updatedAt: { gte: riskPnlStartAt } }
            : { status: 'CLOSED' as const, mode: 'LIVE' as const };
        const consecutiveStartAt = resolveRiskLookbackStart(
            riskPnlStartAt,
            consecutiveLookbackHours,
        );
        const consecutiveWhere = consecutiveStartAt
            ? { status: 'CLOSED' as const, mode: 'LIVE' as const, updatedAt: { gte: consecutiveStartAt } }
            : { status: 'CLOSED' as const, mode: 'LIVE' as const };
        const routeWhere = route ? { route } : {};

        const feeSelect = { profitUsd: true, totalFeesSol: true, solPriceAtEntry: true } as const;
        const [dailyRows, totalRows, recentClosed] = await Promise.all([
            this.prismaService.trade.findMany({
                where: { status: 'CLOSED', mode: 'LIVE', updatedAt: { gte: effectiveDailyStart } },
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
            this.logger.warn(`[Risk] Ignoring invalid RISK_PNL_START_AT="${raw}". Use an ISO timestamp.`);
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
            this.logger.warn(`[DNS] Falling back to temporary pinned IP for ${hostname}: ${fallbackIp}`);
            return fallbackIp;
        }

        return null;
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
        const effectiveDryRun = isManualBuy ? false : chatSettings?.dryRun ?? true;
        const effectiveTotalSlots = chatSettings?.totalSlots ?? this.totalSlots;
        const effectivePositionSizeUSD =
            chatSettings?.positionSizeUsd ?? this.positionSizeUSD;
        const requestedSlippageBps = options?.customSlippageBps ?? (chatSettings
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
                const normalizedStage =
                    params.stage || normalizeBuyFailureStage(normalizedReason);

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

        // 1. Cek apakah sudah punya koin ini (OPEN) atau sedang dalam cooldown
        const recentTrade = await this.prismaService.trade.findFirst({
            where: {
                tokenMint,
                mode: 'LIVE',
                ...(tradeChatDbId ? { telegramChatId: tradeChatDbId } : {}),
            },
            orderBy: { createdAt: 'desc' },
        });

        if (recentTrade && !customAmountUSD) {
            // Jika manual buy (ada customAmount), abaikan cooldown
            if (recentTrade.status === 'OPEN') {
                this.logger.warn(`[BuyTrace] Blocked by already-open trade token=${tokenMint} chat=${telegramChatId}`);
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
                this.logger.warn(`[BuyTrace] Blocked by cooldown token=${tokenMint} chat=${telegramChatId}: ${msg}`);
                await notifyBuyFailure({
                    reason: 'cooldown',
                    details: msg,
                });
                return { success: false, message: msg };
            }
        }

        const openTradesCount = await this.prismaService.trade.count({
            where: {
                status: 'OPEN',
                mode: 'LIVE',
                ...(tradeChatDbId ? { telegramChatId: tradeChatDbId } : {}),
            },
        });
        if (openTradesCount >= effectiveTotalSlots) {
            this.logger.warn(
                `[BuyTrace] Blocked by slot limit token=${tokenMint} chat=${telegramChatId} openTrades=${openTradesCount} slots=${effectiveTotalSlots}`,
            );
            await notifyBuyFailure({
                reason: 'slot_guard',
                details: `Open trades: ${openTradesCount}, Slots: ${effectiveTotalSlots}.`,
            });
            return { success: false, message: 'All trading slots are full.' };
        }

        const openTrades = await this.prismaService.trade.findMany({
            where: {
                status: 'OPEN',
                mode: 'LIVE',
                ...(tradeChatDbId ? { telegramChatId: tradeChatDbId } : {}),
            },
            select: { slotNumber: true, entryValueUsd: true },
        });

        const usedSlots = new Set(openTrades.map((t) => t.slotNumber));
        let slotToUse = 1;
        for (let i = 1; i <= effectiveTotalSlots; i++) {
            if (!usedSlots.has(i)) {
                slotToUse = i;
                break;
            }
        }

        // Use custom amount if provided, otherwise use config
        const buyAmountUSD =
            customAmountUSD ?? this.applyFinalSize(effectivePositionSizeUSD, route, aiPositionSizeMultiplier);
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
                return sum + (Number.isFinite(value) && value > 0 ? value : effectivePositionSizeUSD);
            }, 0);
            const committedCapitalUsd = openExposureUsd + buyAmountUSD;
            const spendableCapitalUsd = Math.max(balanceUsd - dynamicReserveUsd, 0);
            this.logger.log(
                `[BuyTrace] GuardContext token=${tokenMint} route=${route ?? 'GLOBAL'} basePositionSizeUsd=${effectivePositionSizeUSD.toFixed(2)} routeMultiplier=${this.getRouteSizeMultiplier(route).toFixed(3)} aiMultiplier=${sanitizeBuySizeMultiplier(aiPositionSizeMultiplier).toFixed(3)} finalBuyUsd=${buyAmountUSD.toFixed(2)} balanceSol=${balanceSol.toFixed(6)} balanceUsd=${balanceUsd.toFixed(2)} dynamicReserveUsd=${dynamicReserveUsd.toFixed(2)} spendableCapitalUsd=${spendableCapitalUsd.toFixed(2)} openExposureUsd=${openExposureUsd.toFixed(2)} committedCapitalUsd=${committedCapitalUsd.toFixed(2)} requestedSlippageBps=${requestedSlippageBps} selectedSlippageBps=${selectedSlippageBps} maxPriceImpactPct=${this.getRouteMaxPriceImpactPct(route)} dryRun=${effectiveDryRun}`,
            );

            if (committedCapitalUsd > spendableCapitalUsd) {
                const msg = `Capital guard blocked buy. Wallet=$${balanceUsd.toFixed(2)}, Spendable=$${spendableCapitalUsd.toFixed(2)}, Reserve=$${dynamicReserveUsd.toFixed(2)}, CommittedAfterBuy=$${committedCapitalUsd.toFixed(2)}.`;
                this.logger.warn(`[BuyTrace] Blocked by dynamic capital guard token=${tokenMint} chat=${telegramChatId} ${msg}`);
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
                this.logger.warn(`[BuyTrace] Blocked by balance token=${tokenMint} chat=${telegramChatId} wallet=${wallet.publicKey.toBase58()} balanceSol=${balanceSol.toFixed(6)}`);
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
            this.logger.error(`[BuyTrace] Capital protection exception token=${tokenMint} chat=${telegramChatId}: ${msg}`);
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

        this.logger.log(
            `[Slot ${slotToUse}] Attempting to buy ${tokenMint} route=${route ?? 'GLOBAL'} with $${buyAmountUSD.toFixed(2)} (${amountInSol.toFixed(4)} SOL)`,
        );

        const { success, entryPrice, error, txHash, actualSol, actualTokens, totalFeesSol } =
            await this.executeJupiterSwap(
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
            );

        if (success && entryPrice > 0) {
            const finalAmountInSol = actualSol || amountInSol;
            const entryValueUsd = finalAmountInSol * solPrice;
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
            // Get initial balances for watch addresses
            let initialCreatorBalance = 0;
            let initialTopHolderBalance = 0;

            if (metadata?.creator) {
                const bal = await this.getTokenBalance(metadata.creator, tokenMint);
                initialCreatorBalance = typeof bal === 'number' ? bal : 0;
            }
            if (metadata?.topHolder) {
                const bal = await this.getTokenBalance(metadata.topHolder, tokenMint);
                initialTopHolderBalance = typeof bal === 'number' ? bal : 0;
            }

            const createdTrade = await this.prismaService.trade.create({
                data: {
                    tokenMint,
                    symbol,
                    slotNumber: slotToUse,
                    entryPrice,
                    highestPrice: entryPrice,
                    trailingStopPrice: 0, // PriceMonitor activates it once the position is in profit.
                    status: 'OPEN',
                    mode: 'LIVE',
                    route,
                    aiDecisionSnapshotId,
                    amountInSol: finalAmountInSol,
                    buyTxHash: txHash || null,
                    entryLiquidity: metadata?.liquidity || 0,
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
            await this.updateTradeAuditFields(createdTrade.id, {
                solPriceAtEntry: solPrice,
                entryValueUsd,
                totalFeesSol: totalFeesSol || 0,
            });
            this.logger.log(`[Slot ${slotToUse}] Successfully bought ${symbol} (${tokenMint})`);
            this.logger.log(
                `[BuyTrace] Success token=${tokenMint} chat=${telegramChatId} slot=${slotToUse} tx=${txHash || 'n/a'}`,
            );
            const strategyName = options?.targetTakeProfit
                ? 'Established Rebound & CTO (TP 18%, TSL 2.5%, Hard SL 20%)'
                : 'Standard Second-Wave';
            await this.reportingService.sendBuyAlert(
                tokenMint,
                entryPrice,
                slotToUse,
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
            return { success: true, message: `Successfully bought ${symbol} at slot ${slotToUse}` };
        }

        this.logger.warn(`[BuyTrace] Swap failed token=${tokenMint} chat=${telegramChatId}: ${error || 'Unknown error'}`);
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
            tradeDryRun = forceLive ? false : tradeSettings?.dryRun ?? true;
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
                    await this.prismaService.trade.update({
                        where: { id: tradeId },
                        data: { status: 'CLOSED', exitPrice: 0, profitUsd: 0, exitReason },
                    });
                }
                return false;
            }

            this.logger.log(
                `[Slot ${trade.slotNumber}] 💸 Executing SELL (${(percentage * 100).toFixed(0)}%) for ${trade.symbol} (${trade.tokenMint}). Amount: ${sellAmount}`,
            );

            // 2. PANIC SLIPPAGE: Kalau SL, Trailing Stop, atau Rugpull, hajar slippage 15% (1500 bps) biar pasti laku
            const isUrgent = [
                'STOP_LOSS',
                'TRAILING_STOP',
                'DEV_DUMP',
                'RUGPULL',
                'PANIC_SELL',
                'AI_HEALTH_CRITICAL',
            ].includes(exitReason);
            const sellSlippage = isUrgent ? 1500 : this.slippageBps;

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
            } = await this.executeJupiterSwap(
                trade.tokenMint,
                'So11111111111111111111111111111111111111112',
                amountInLamports,
                'SELL',
                trade.entryValueUsd ?? undefined, // notional for Jito-size gate (NOT used for SELL pricing)
                0,
                sellSlippage,
                sellPriorityFee,
                activeWallet,
                tradeDryRun,
            );

            if (success) {
                const exitPrice = exitPriceResult || 0;
                const profit = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
                const solPrice = await this.getSolPrice();

                const finalSolReceived = actualSol || (sellAmount * exitPrice) / solPrice;
                const finalTokensSold = actualTokens || sellAmount;
                const entrySolValue = trade.amountInSol * percentage;
                const solProfitPercent = ((finalSolReceived - entrySolValue) / entrySolValue) * 100;

                const entryValueUsd = this.getEntryValueUsdForSell(trade, percentage, solPrice);
                const exitValueUsd = sellAmount * exitPrice;
                const estimatedProfitUsd = exitValueUsd - entryValueUsd;
                const totalUsdSpent = finalTokensSold * trade.entryPrice;
                const totalUsdReceived = finalTokensSold * exitPrice;

                // ✅ DATABASE UPDATE: Hanya dilakukan jika transaksi Solana SUKSES
                if (percentage >= 1.0) {
                    await this.prismaService.trade.update({
                        where: { id: tradeId },
                        data: {
                            status: 'CLOSED',
                            exitPrice,
                            exitReason,
                            sellTxHash: txHash || null,
                            profitUsd: (trade.profitUsd || 0) + estimatedProfitUsd,
                        },
                    });
                } else {
                    const remainingEntryValueUsd =
                        trade.entryValueUsd !== null && trade.entryValueUsd !== undefined
                            ? trade.entryValueUsd * (1 - percentage)
                            : undefined;
                    const partialTakeProfitAt =
                        exitReason === 'PARTIAL_TAKE_PROFIT'
                            ? new Date()
                            : trade.partialTakeProfitAt;
                    const runnerFloorPercent = Number.parseFloat(
                        this.configService.get<string>('RUNNER_BREAKEVEN_FLOOR_PERCENT') || '8',
                    );
                    const runnerStopPrice =
                        exitReason === 'PARTIAL_TAKE_PROFIT'
                            ? trade.entryPrice *
                              (1 + (Number.isFinite(runnerFloorPercent) ? runnerFloorPercent : 8) / 100)
                            : trade.trailingStopPrice;

                    await this.prismaService.trade.update({
                        where: { id: tradeId },
                        data: {
                            amountInSol: trade.amountInSol * (1 - percentage),
                            entryValueUsd: remainingEntryValueUsd,
                            partialTakeProfitAt,
                            trailingStopPrice: runnerStopPrice,
                            profitUsd: (trade.profitUsd || 0) + estimatedProfitUsd,
                        },
                    });
                }
                if (totalFeesSol) {
                    await this.incrementTradeFees(tradeId, totalFeesSol);
                }

                // 🧑‍💻 AUTO BLACKLIST ON DEV_DUMP/RUGPULL (Self-Learning)
                if (['DEV_DUMP', 'RUGPULL'].includes(exitReason) && trade.creatorAddress) {
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

                await this.reportingService.sendSellAlert(
                    trade.tokenMint,
                    exitPrice,
                    profit,
                    exitReason,
                    trade.symbol || undefined,
                    {
                        entryPriceUsd: trade.entryPrice,
                        exitPriceUsd: exitPrice,
                        entryPriceSol: entrySolValue / finalTokensSold,
                        exitPriceSol: finalSolReceived / finalTokensSold,
                        solSpent: entrySolValue,
                        solReceived: finalSolReceived,
                        solProfitPercent,
                        usdSpent: totalUsdSpent,
                        usdReceived: totalUsdReceived,
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
                return true;
            }

            // ❌ SELL FAILED — trade tetap OPEN (tidak pernah di-CLOSED sebelum swap)
            this.logger.error(
                `[Slot ${trade.slotNumber}] ❌ SELL FAILED on Solana: ${error}. Trade remains OPEN for retry.`,
            );
            if (error?.startsWith('price_anomaly')) {
                this.queuePriceAnomalyRetry(tradeId, currentPrice, exitReason, percentage);
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
    ): Promise<{
        success: boolean;
        entryPrice: number;
        error?: string;
        txHash?: string;
        actualSol?: number;
        actualTokens?: number;
        totalFeesSol?: number;
    }> {
        const maxRetries = Number.parseInt(
            this.configService.get<string>('TRADE_MAX_RETRIES', '5'),
            10,
        );
        if (!wallet) {
            throw new Error('Live swap execution requires a chat wallet.');
        }
        const activeWallet = wallet;
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
            } else if (retryCount > 0) {
                slippage = Math.min(requestedSlippageBps + retryCount * 250, 2000);
                this.logger.warn(`[Jupiter] Retrying SELL with higher slippage: ${slippage} bps`);
            }
            const quoteUrl = `${baseUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}`;
            const quoteResponse = await axios.get(quoteUrl, config);
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
            } else {
                // SELL: Price = (outAmount_sol * solPrice) / inAmount_token
                const solPrice = await this.getSolPrice();
                const outAmountSol = quoteData.outAmount / 1_000_000_000;
                const inAmountToken = amount / Math.pow(10, decimals);
                const calculatedPrice = (outAmountSol * solPrice) / inAmountToken;
                const fallbackPrice = await this.getSellPriceFallback(inputMint);
                price = validateSellPrice(calculatedPrice, fallbackPrice, inputMint, this.logger);
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
                this.logger.warn('[Jupiter] Falling back to direct send on retry to avoid bundle expiry.');
            }

            const swapResponse = await axios.post(
                `${baseUrl}/swap/v1/swap`,
                {
                    quoteResponse: quoteData,
                    userPublicKey: activeWallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: feeConfig,
                },
                config,
            );

            const transaction = VersionedTransaction.deserialize(
                Buffer.from(swapResponse.data.swapTransaction, 'base64'),
            );
            transaction.sign([activeWallet]);
            const confirmationBlockhash = transaction.message.recentBlockhash;
            const swapLastValidBlockHeight = Number(swapResponse.data?.lastValidBlockHeight);
            const hasSwapLastValidBlockHeight =
                Number.isFinite(swapLastValidBlockHeight) && swapLastValidBlockHeight > 0;
            const jitoTipLamports = useJito ? Math.floor(jitoTipSol * 1_000_000_000) : 0;

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
                        throw new Error(
                            `Jito Bundle Error: ${JSON.stringify(bundleResponse.data.error)}`,
                        );
                    }

                    this.logger.log(
                        `[Jito] 🎉 Bundle accepted! ID: ${bundleResponse.data?.result}`,
                    );
                    txid = bs58.encode(transaction.signatures[0]);
                } catch (e: unknown) {
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
                txid = await this.connection.sendRawTransaction(transaction.serialize(), {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: 3,
                });
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
                    const solPrice = await this.getSolPrice();
                    totalFeesSol = actualSwap.totalFeesSol;
                    actualSol = actualSwap.cleanSolAmount ?? Math.abs(actualSwap.solChange);
                    actualTokens = Math.abs(actualSwap.tokenChange);
                    if (side === 'BUY') {
                        if (actualTokens > 0) {
                            finalPrice = (actualSol * solPrice) / actualTokens;
                            this.logger.log(
                                `[Jupiter] Actual BUY price calculated from on-chain balances: $${finalPrice.toFixed(8)} (Quote: $${price.toFixed(8)})`,
                            );
                        }
                    } else {
                        if (actualTokens > 0) {
                            finalPrice = (actualSol * solPrice) / actualTokens;
                            this.logger.log(
                                `[Jupiter] Actual SELL price calculated from on-chain balances: $${finalPrice.toFixed(8)} (Quote: $${price.toFixed(8)})`,
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
            if (retryCount < maxRetries - 1) {
                const waitTime = 1000 * (retryCount + 1);
                this.logger.log(`[Jupiter] Retrying in ${waitTime}ms...`);
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
            const dexSymbol = response.data?.pairs?.[0]?.baseToken?.symbol;
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
            const response = await axios.get(`https://api.jup.ag/price/v3?ids=${tokenMint}`, {
                timeout: 5000,
                headers: { 'x-api-key': this.jupiterApiKey },
                httpsAgent: this.httpsAgent,
            });
            const data = response.data as Record<string, { usdPrice?: number } | undefined> | null;
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

            if (accounts.value.length > 0) {
                return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
            }
            return 0;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to get token balance for ${walletAddress}: ${msg}`);
            return null; // Return null biar bot tahu ini error API, bukan saldo 0
        }
    }

    async getSolPrice(): Promise<number> {
        try {
            const response = await axios.get(
                `https://api.jup.ag/price/v3?ids=${WRAPPED_SOL_MINT}`,
                {
                    timeout: 3000,
                    headers: { 'x-api-key': this.jupiterApiKey },
                    httpsAgent: this.httpsAgent,
                },
            );
            const data = response.data as Record<string, { usdPrice?: number } | undefined> | null;
            return data?.[WRAPPED_SOL_MINT]?.usdPrice || 150;
        } catch {
            return 150; // Fallback jika API Jupiter down
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

        const currentPrice = await this.reportingService.fetchCurrentPrice(tokenMint);
        if (!currentPrice) {
            return { success: false, message: 'Failed to fetch current price.' };
        }

        if (trade) {
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
            const actualBalance = await this.getTokenBalance(wallet.publicKey.toBase58(), tokenMint);
            if (actualBalance === null || actualBalance <= 0)
                return { success: false, message: 'Zero or invalid balance in wallet.' };

            const decimals = await this.getTokenDecimals(tokenMint);
            const amountInLamports = Math.floor(
                actualBalance * percentage * Math.pow(10, decimals),
            );

            const { success, error } = await this.executeJupiterSwap(
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

        if (!destinationAddress || !this.isValidSolanaAddress(destinationAddress)) {
            return { success: false, message: 'Invalid destination Solana address.' };
        }

        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return { success: false, message: 'Invalid transfer amount.' };
        }

        const wallet = await this.getWallet(chatId);
        const recipient = new PublicKey(destinationAddress);
        const balanceLamports = await this.connection.getBalance(wallet.publicKey);
        const balanceSol = balanceLamports / 1_000_000_000;
        const reserveSol = 0.005;
        const spendableSol = Math.max(balanceSol - reserveSol, 0);
        const solPrice = amountMode === 'usd' ? await this.getSolPrice() : null;
        const transferSol =
            amountMode === 'percent'
                ? spendableSol * amountValue
                : amountValue / (solPrice || 150);

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

    async getWalletHoldingsForChat(chatId: string): Promise<
        Array<{ mint: string; symbol: string; balance: number }>
    > {
        const wallet = await this.getWallet(chatId);
        const [onChainHoldings, chatRecord] = await Promise.all([
            this.getWalletHoldings(wallet.publicKey.toBase58()),
            this.telegramWorkspace.getChatById(chatId),
        ]);

        const holdingsByMint = new Map<
            string,
            { mint: string; symbol: string; balance: number }
        >();

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
                    const currentPrice = await this.reportingService.fetchCurrentPrice(trade.tokenMint);
                    if (currentPrice && trade.entryPrice > 0) {
                        const estimatedUsdValue = trade.amountInSol * (trade.solPriceAtEntry || currentPrice);
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

        return Array.from(holdingsByMint.values()).sort((a, b) =>
            a.symbol.localeCompare(b.symbol),
        );
    }

    async getPortfolioForChat(chatId: string): Promise<
        Array<{
            mint: string;
            symbol: string;
            balance: number;
            entryPriceUsd?: number;
            currentPriceUsd?: number;
            valueUsd?: number;
            pnlUsd?: number;
            pnlPercent?: number;
            source: 'ON_CHAIN' | 'DB';
        }>
    > {
        const wallet = await this.getWallet(chatId);
        const [onChainHoldings, chatRecord] = await Promise.all([
            this.getWalletHoldings(wallet.publicKey.toBase58()),
            this.telegramWorkspace.getChatById(chatId),
        ]);

        const portfolioByMint = new Map<
            string,
            {
                mint: string;
                symbol: string;
                balance: number;
                entryPriceUsd?: number;
                currentPriceUsd?: number;
                valueUsd?: number;
                pnlUsd?: number;
                pnlPercent?: number;
                source: 'ON_CHAIN' | 'DB';
            }
        >();

        for (const holding of onChainHoldings) {
            portfolioByMint.set(holding.mint, {
                mint: holding.mint,
                symbol: holding.symbol,
                balance: holding.balance,
                source: 'ON_CHAIN',
            });
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
                const currentPriceUsd = await this.reportingService.fetchCurrentPrice(trade.tokenMint);
                const balance = portfolioByMint.get(trade.tokenMint)?.balance || 0;
                const entryPriceUsd = trade.entryPrice || undefined;
                const valueUsd = currentPriceUsd && balance > 0 ? currentPriceUsd * balance : undefined;
                const entryValueUsd =
                    trade.entryValueUsd !== null && trade.entryValueUsd !== undefined
                        ? trade.entryValueUsd
                        : undefined;
                const pnlUsd =
                    valueUsd !== undefined && entryValueUsd !== undefined
                        ? valueUsd - entryValueUsd
                        : undefined;
                const pnlPercent =
                    pnlUsd !== undefined && entryValueUsd !== undefined && entryValueUsd > 0
                        ? (pnlUsd / entryValueUsd) * 100
                        : undefined;

                portfolioByMint.set(trade.tokenMint, {
                    mint: trade.tokenMint,
                    symbol: trade.symbol || 'UNKNOWN',
                    balance,
                    entryPriceUsd,
                    currentPriceUsd: currentPriceUsd || undefined,
                    valueUsd,
                    pnlUsd,
                    pnlPercent,
                    source: 'DB',
                });
            }
        }

        return Array.from(portfolioByMint.values()).sort((a, b) =>
            a.symbol.localeCompare(b.symbol),
        );
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
