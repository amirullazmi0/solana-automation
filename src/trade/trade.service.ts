import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Trade as PrismaTrade } from '@prisma/client';
import {
    Connection,
    Keypair,
    ParsedTransactionWithMeta,
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import axios from 'axios';
import bs58 from 'bs58';
import * as https from 'https';
import { DexLimiter } from '../common/dex-limiter';
import { TokenMetadata, TradeExecutionPayload } from '../dto/analyzer.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ReportingService } from '../reporting/reporting.service';
import { TelegramWorkspaceService } from '../telegram/telegram-workspace.service';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

type TradeAuditFields = {
    solPriceAtEntry?: number | null;
    entryValueUsd?: number | null;
    totalFeesSol?: number | null;
};

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
): { cleanSolAmount: number | null; totalFeesSol: number } {
    const totalNoiseLamports = networkFeeLamports + rentDeltaLamports + jitoTipLamports;
    const cleanLamports = rawSolDeltaLamports - totalNoiseLamports;
    return {
        cleanSolAmount:
            cleanLamports > 0 && cleanLamports <= rawSolDeltaLamports
                ? cleanLamports / 1_000_000_000
                : null,
        totalFeesSol: totalNoiseLamports / 1_000_000_000,
    };
}

export type BuyRiskMetrics = {
    dailyRealizedPnlUsd: number;
    consecutiveLosses: number;
    totalRealizedPnlUsd: number;
};

export type BuyRiskConfig = {
    disabledUntilMs: number | null;
    dailyMaxLossUsd: number; // blocks when daily PnL <= -dailyMaxLossUsd
    maxConsecutiveLosses: number; // blocks when consecutiveLosses >= limit
    maxDrawdownPct: number; // blocks when total PnL <= -(totalCapital * pct/100)
};

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
    private readonly slippageBps: number;
    private readonly jupiterApiKey: string;
    private readonly isDryRun: boolean;
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
        const rpcEndpoint =
            this.configService.get<string>('RPC_ENDPOINT') || 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(rpcEndpoint, 'confirmed');
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

        this.slippageBps = Number.parseInt(
            this.configService.get<string>('SLIPPAGE_BPS', '100'),
            10,
        );
        this.isDryRun = this.configService.get<string>('DRY_RUN') === 'true';

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
        if (this.connection && !this.isDryRun) {
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
        } else if (this.isDryRun) {
            this.logger.log('[DRY_RUN] Chat-generated wallets available; live swaps remain disabled.');
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

    private getStartOfDayUtc(): Date {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        return d;
    }

    private async getBuyRiskMetrics(maxConsecutiveLosses: number): Promise<BuyRiskMetrics> {
        const dayStart = this.getStartOfDayUtc();

        const [dailyAgg, totalAgg, recentClosed] = await Promise.all([
            this.prismaService.trade.aggregate({
                where: { status: 'CLOSED', mode: 'LIVE', updatedAt: { gte: dayStart } },
                _sum: { profitUsd: true },
            }),
            this.prismaService.trade.aggregate({
                where: { status: 'CLOSED', mode: 'LIVE' },
                _sum: { profitUsd: true },
            }),
            maxConsecutiveLosses > 0
                ? this.prismaService.trade.findMany({
                      where: { status: 'CLOSED', mode: 'LIVE' },
                      orderBy: { updatedAt: 'desc' },
                      take: Math.min(maxConsecutiveLosses, 50),
                      select: { profitUsd: true },
                  })
                : Promise.resolve([] as Array<{ profitUsd: number | null }>),
        ]);

        const dailyRealizedPnlUsd = dailyAgg._sum.profitUsd ?? 0;
        const totalRealizedPnlUsd = totalAgg._sum.profitUsd ?? 0;

        let consecutiveLosses = 0;
        if (maxConsecutiveLosses > 0) {
            for (const t of recentClosed) {
                const p = t.profitUsd ?? 0;
                if (p < 0) consecutiveLosses++;
                else break;
            }
        }

        return { dailyRealizedPnlUsd, consecutiveLosses, totalRealizedPnlUsd };
    }

    /**
     * Helper to resolve DNS using Google DNS-over-HTTPS if standard lookup fails
     */
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
        options?: {
            customSlippageBps?: number;
            priorityFeeSol?: number;
            targetTakeProfit?: number;
            targetStopLoss?: number;
            targetTrailingDistance?: number;
        },
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
        const effectiveDryRun = telegramChatId
            ? chatSettings?.dryRun ?? this.isDryRun
            : this.isDryRun;
        const effectiveTotalSlots = chatSettings?.totalSlots ?? this.totalSlots;
        const effectivePositionSizeUSD =
            chatSettings?.positionSizeUsd ?? this.positionSizeUSD;
        const effectiveSlippageBps = chatSettings
            ? Math.max(1, Math.round(chatSettings.slippageOnSol * 10000))
            : this.slippageBps;
        const wallet = await this.getWallet(telegramChatId);
        const tradeChatDbId = chatRecord?.id;

        if (effectiveDryRun) {
            const symbol = await this.fetchTokenSymbol(tokenMint);
            return {
                success: true,
                message: `[DRY_RUN] Signal only. No live swap executed for ${symbol}.`,
            };
        }

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
        if (openTradesCount >= effectiveTotalSlots && !customAmountUSD) {
            return { success: false, message: 'All trading slots are full.' };
        }

        const openTrades = await this.prismaService.trade.findMany({
            where: {
                status: 'OPEN',
                mode: 'LIVE',
                ...(tradeChatDbId ? { telegramChatId: tradeChatDbId } : {}),
            },
            select: { slotNumber: true },
        });

        const usedSlots = new Set(openTrades.map((t) => t.slotNumber));
        let slotToUse = 1;
        for (let i = 1; i <= this.totalSlots; i++) {
            if (!usedSlots.has(i)) {
                slotToUse = i;
                break;
            }
        }

        // Use custom amount if provided, otherwise use config
        const buyAmountUSD = customAmountUSD || effectivePositionSizeUSD;
        const committedCapitalUsd = openTradesCount * effectivePositionSizeUSD + buyAmountUSD;
        const spendableCapitalUsd = Math.max(this.totalCapital - this.reserveAmount, 0);
        if (!customAmountUSD && committedCapitalUsd > spendableCapitalUsd) {
            return {
                success: false,
                message: `Capital guard blocked buy. Committed after buy would be $${committedCapitalUsd.toFixed(2)}, spendable cap is $${spendableCapitalUsd.toFixed(2)}.`,
            };
        }

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
                this.configService.get<string>('MAX_CONSECUTIVE_LOSSES', '0'),
                10,
            );
            const maxDrawdownPct = Number.parseFloat(
                this.configService.get<string>('MAX_DRAWDOWN_PCT', '0'),
            );

            const metrics = await this.getBuyRiskMetrics(maxConsecutiveLosses);
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
                    `dailyPnL=$${metrics.dailyRealizedPnlUsd.toFixed(2)}, ` +
                    `consecutiveLosses=${metrics.consecutiveLosses}, ` +
                    `totalPnL=$${metrics.totalRealizedPnlUsd.toFixed(2)}.`;
                this.logger.warn(`[Risk] ${msg}`);
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
            slippage: options?.customSlippageBps || effectiveSlippageBps,
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
                return {
                    success: false,
                    message: 'Capital guard blocked buy. Invalid SOL price or buy amount.',
                };
            }

            const wallet = await this.getWallet(telegramChatId);
            const balanceLamports = await this.connection.getBalance(wallet.publicKey);
            const balanceSol = balanceLamports / 1_000_000_000;
            const reserveSol = this.reserveAmount / solPrice;
            const totalRequiredSol = executionPayload.amountSol + reserveSol + 0.005;
            const balanceAfterBuy = balanceSol - executionPayload.amountSol;

            if (balanceAfterBuy < reserveSol || balanceSol < totalRequiredSol) {
                const msg = `Insufficient SOL balance. Have: ${balanceSol.toFixed(4)} SOL, Need: ${totalRequiredSol.toFixed(4)} SOL (Position: ${executionPayload.amountSol.toFixed(4)} SOL, Reserve: ${reserveSol.toFixed(4)} SOL + Fees). Aborting buy to prevent trapped tokens or wasted fees.`;
                this.logger.warn(`[Slot ${slotToUse}] ${msg}`);
                return { success: false, message: msg };
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[Slot ${slotToUse}] Capital protection check failed: ${msg}`);
            return {
                success: false,
                message: `Capital protection check failed: ${msg}`,
            };
        }

        this.logger.log(
            `[Slot ${slotToUse}] Attempting to buy ${tokenMint} with $${buyAmountUSD} (${amountInSol.toFixed(4)} SOL)`,
        );

        const { success, entryPrice, error, txHash, actualSol, actualTokens, totalFeesSol } =
            await this.executeJupiterSwap(
                WRAPPED_SOL_MINT,
                tokenMint,
                amountInLamports,
                'BUY',
                buyAmountUSD,
                0,
                options?.customSlippageBps || effectiveSlippageBps,
                priorityFeeLamports,
                wallet,
            );

        if (success && entryPrice > 0) {
            const finalAmountInSol = actualSol || amountInSol;
            const entryValueUsd = finalAmountInSol * solPrice;
            const symbol = await this.fetchTokenSymbol(tokenMint);
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
            );

            // PriceMonitorService otomatis akan mendeteksi trade baru dari DB
            return { success: true, message: `Successfully bought ${symbol} at slot ${slotToUse}` };
        }

        return { success: false, message: `Swap failed: ${error || 'Unknown error'}` };
    }

    async executeSell(
        tradeId: number,
        currentPrice: number,
        exitReason: string,
        percentage: number = 1.0,
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

        try {
            // 1. DAPETIN SALDO ASLI ATAU SIMULASI
            let actualBalance = 0;
            if (this.isDryRun) {
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
                undefined,
                0,
                sellSlippage,
                sellPriorityFee,
                activeWallet,
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
                    await this.prismaService.trade.update({
                        where: { id: tradeId },
                        data: {
                            amountInSol: trade.amountInSol * (1 - percentage),
                            entryValueUsd: remainingEntryValueUsd,
                            partialTakeProfitAt:
                                exitReason === 'PARTIAL_TAKE_PROFIT'
                                    ? new Date()
                                    : trade.partialTakeProfitAt,
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
                );
                return true;
            }

            // ❌ SELL FAILED — trade tetap OPEN (tidak pernah di-CLOSED sebelum swap)
            this.logger.error(
                `[Slot ${trade.slotNumber}] ❌ SELL FAILED on Solana: ${error}. Trade remains OPEN for retry.`,
            );
            if (error?.startsWith('price_anomaly')) {
                this.queuePriceAnomalyRetry(tradeId, currentPrice, exitReason, percentage);
            }
            return false;
        } catch (error) {
            this.logger.error(
                `[Slot ${trade.slotNumber}] ❌ SELL CRITICAL ERROR: ${error instanceof Error ? error.message : String(error)}`,
            );
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

            // 🛠 DYNAMIC SLIPPAGE: Naikin slippage tiap kali gagal
            let slippage = customSlippageBps || this.slippageBps;
            if (retryCount > 0) {
                slippage = Math.min(slippage + retryCount * 250, 2000); // Tambah 2.5% tiap retry, max 20%
                this.logger.warn(`[Jupiter] Retrying with higher slippage: ${slippage} bps`);
            }

            const quoteUrl = `${baseUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}`;
            const quoteResponse = await axios.get(quoteUrl, config);
            const quoteData = quoteResponse.data;

            // 🛡️ PRICE IMPACT GUARD
            if (side === 'BUY' && quoteData.priceImpactPct) {
                const priceImpact = parseFloat(quoteData.priceImpactPct);
                const maxPriceImpact = parseFloat(
                    this.configService.get<string>('MAX_PRICE_IMPACT_PCT', '15.0'),
                );
                if (priceImpact > maxPriceImpact) {
                    this.logger.warn(
                        `[Jupiter] 🛑 BUY rejected due to high price impact: ${priceImpact}% (Max allowed: ${maxPriceImpact}%)`,
                    );
                    return {
                        success: false,
                        entryPrice: 0,
                        error: `high_price_impact: ${priceImpact}%`,
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
            if (this.isDryRun) {
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
            const useJito = this.configService.get<string>('USE_JITO') === 'true';
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
        const rentDeltaLamports = this.calculateRentDelta(tx, walletIndex);
        const { cleanSolAmount, totalFeesSol } = calculateCleanSwapSolAmount(
            rawSolDeltaLamports,
            networkFeeLamports,
            rentDeltaLamports,
            0,
        );
        const totalFeesWithBundleTipSol = totalFeesSol + bundleTipLamports / 1_000_000_000;

        if (cleanSolAmount === null) {
            this.logger.error(
                `[SwapDetails] Invalid clean SOL amount. raw=${rawSolDeltaLamports}, feesSol=${totalFeesWithBundleTipSol}. Falling back to quote price.`,
            );
        }

        return {
            solChange,
            tokenChange,
            cleanSolAmount,
            totalFeesSol: totalFeesWithBundleTipSol,
        };
    }

    private calculateRentDelta(tx: ParsedTransactionWithMeta, walletIndex: number): number {
        const preBalances = tx.meta?.preBalances || [];
        const postBalances = tx.meta?.postBalances || [];
        let rentDelta = 0;

        for (let i = 0; i < Math.min(preBalances.length, postBalances.length); i++) {
            if (i === walletIndex) continue;
            const delta = Math.abs((postBalances[i] || 0) - (preBalances[i] || 0));
            if (delta > 0 && delta <= 20_000_000) rentDelta += delta;
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
        const chatSettings = chatId ? await this.telegramWorkspace.getChatSettings(chatId) : null;
        if (chatSettings?.dryRun) {
            const symbol = await this.fetchTokenSymbol(tokenMint);
            return {
                success: true,
                message: `[DRY_RUN] Signal only. No live sell executed for ${symbol}.`,
            };
        }
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
            await this.executeSell(trade.id, currentPrice, 'MANUAL_SELL', percentage);
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

    async getWalletHoldingsForChat(chatId: string): Promise<
        Array<{ mint: string; symbol: string; balance: number }>
    > {
        const wallet = await this.getWallet(chatId);
        return this.getWalletHoldings(wallet.publicKey.toBase58());
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
            select: { profitUsd: true },
        });
        const total = trades.length;
        const wins = trades.filter((trade) => (trade.profitUsd || 0) > 0).length;
        const losses = total - wins;
        const winRate = total > 0 ? (wins / total) * 100 : 0;

        return { total, wins, losses, winRate };
    }
}
