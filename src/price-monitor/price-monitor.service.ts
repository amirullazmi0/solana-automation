import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Trade } from '@prisma/client';
import axios from 'axios';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { ReportingService } from '../reporting/reporting.service';
import { TradeService } from '../trade/trade.service';
import { DexLimiter } from '../common/dex-limiter';
import { AIService } from '../ai/ai.service';
import { TelegramWorkspaceService } from '../telegram/telegram-workspace.service';
import { DexScreenerPair } from '../dto/analyzer.dto';
import { AIHealthCheckMetrics, AIHealthCheckResult } from '../dto/ai.dto';

interface TradeFreshMarketSignals {
    priceUsd: number;
    volScore: number;
    priceChange1h: number;
    liquidityUsd: number;
    marketCapUsd: number;
    volume5mUsd: number;
    volume1hUsd: number;
    buys5mCount: number;
    sells5mCount: number;
    volumeSurge: number;
    zScore: number;
}

interface DexScreenerPairWithPriceUsd extends DexScreenerPair {
    priceUsd?: string;
}

interface DexScreenerBatchResponse {
    pairs?: DexScreenerPairWithPriceUsd[];
}

type TradeWithTelegramChat = Trade & {
    telegramChat?: {
        chatId: string;
    } | null;
};

@Injectable()
export class PriceMonitorService {
    private readonly logger = new Logger(PriceMonitorService.name);
    private trailingDistancePercent: number;
    private jupiterApiKey: string;
    private stopLossPercent: number;
    private readonly newTokenPatienceThresholdMinutes: number;
    private readonly conservativeExitGuardEnabled: boolean;
    private readonly minNonCriticalHoldMs: number;
    private readonly healthCheckBeforeEarlySl: boolean;
    private readonly healthCheckBeforeEarlyTrailing: boolean;
    private readonly minNetExitProfitPercent: number;
    private readonly minTrailingDistanceBeforePartialPercent: number;
    private readonly lastAlertTime = new Map<string, number>(); // Cooldown alert: tokenMint -> timestamp
    private readonly lastRiskAdjustmentAlertTime = new Map<string, number>();
    private readonly healthCheckCache = new Map<number, { checkedAt: number; result: AIHealthCheckResult }>();
    private ipCache: Record<string, string> = {};
    private readonly fallbackApiIps: Record<string, string> = {
        'api.jup.ag': '18.239.105.107',
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly tradeService: TradeService,
        private readonly telegramWorkspace: TelegramWorkspaceService,
        private readonly reportingService: ReportingService,
        private readonly aiService: AIService,
    ) {
        this.trailingDistancePercent = parseFloat(
            this.configService.get<string>('TRAILING_DISTANCE_PERCENT', '5.0'),
        );
        this.stopLossPercent = parseFloat(
            this.configService.get<string>('STOP_LOSS_PERCENT', '25.0'),
        );
        this.newTokenPatienceThresholdMinutes = parseFloat(
            this.configService.get<string>('SL_PATIENCE_NEW_TOKEN_MINUTES', '30'),
        );
        this.conservativeExitGuardEnabled = this.getBooleanConfig(
            'ENABLE_CONSERVATIVE_EXIT_GUARD',
            true,
        );
        this.minNonCriticalHoldMs = Math.max(
            0,
            this.getNumberConfig('MIN_NON_CRITICAL_HOLD_SECONDS', 60) * 1000,
        );
        this.healthCheckBeforeEarlySl = this.getBooleanConfig(
            'HEALTH_CHECK_BEFORE_EARLY_SL',
            true,
        );
        this.healthCheckBeforeEarlyTrailing = this.getBooleanConfig(
            'HEALTH_CHECK_BEFORE_EARLY_TRAILING',
            true,
        );
        this.minNetExitProfitPercent = Math.max(
            0,
            this.getNumberConfig('MIN_NET_EXIT_PROFIT_PERCENT', 3),
        );
        this.minTrailingDistanceBeforePartialPercent = Math.max(
            0,
            this.getNumberConfig('MIN_TRAILING_DISTANCE_BEFORE_PARTIAL_PERCENT', 3),
        );
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
    }

    private getBooleanConfig(key: string, fallback: boolean): boolean {
        const raw = this.configService.get<string>(key, String(fallback));
        if (typeof raw === 'boolean') return raw;
        const normalized = String(raw).trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
        return fallback;
    }

    private getNumberConfig(key: string, fallback: number): number {
        const value = Number.parseFloat(this.configService.get<string>(key, String(fallback)));
        return Number.isFinite(value) ? value : fallback;
    }

    private getRouteNumberConfig(
        route: string | null | undefined,
        micinKey: string,
        whaleKey: string,
        fallbackKey: string,
        fallback: number,
    ): number {
        if (route === 'MICIN') return this.getNumberConfig(micinKey, fallback);
        if (route === 'WHALE') return this.getNumberConfig(whaleKey, fallback);
        return this.getNumberConfig(fallbackKey, fallback);
    }
    private readonly processingTrades = new Set<number>();

    private calculateNoisePressure(signals: TradeFreshMarketSignals): { severity: number; reasons: string[]; isFakePump: boolean } {
        let severity = 0;
        const reasons: string[] = [];

        const verticalFiveMinutePump =
            signals.priceChange1h <= 0 &&
            signals.volumeSurge >= 2.5 &&
            signals.volScore < 0.35 &&
            signals.zScore < 1.25 &&
            signals.priceChange1h >= -15 &&
            signals.priceUsd > 0 &&
            signals.volume5mUsd > 0;
        if (verticalFiveMinutePump) {
            severity += 35;
            reasons.push('vertical-5m');
        }

        const weakSupport = signals.volumeSurge >= 2 && signals.volScore < 0.4;
        if (weakSupport) {
            severity += 25;
            reasons.push('weak-vol-support');
        }

        const weakAnomaly = signals.volumeSurge >= 2 && signals.zScore < 1.25;
        if (weakAnomaly) {
            severity += 20;
            reasons.push('weak-z-support');
        }

        const sellPressure = signals.sells5mCount > signals.buys5mCount * 1.1 && signals.sells5mCount >= 5;
        if (sellPressure) {
            severity += 20;
            reasons.push('sell-pressure');
        }

        if (signals.buys5mCount === 0 && signals.sells5mCount > 0 && signals.volumeSurge >= 2) {
            severity += 15;
            reasons.push('no-buy-support');
        }

        if (signals.priceChange1h < 0 && signals.priceUsd > 0 && signals.volumeSurge >= 1.8) {
            severity += 10;
            reasons.push('1h-down');
        }

        severity = Math.max(0, Math.min(100, Math.round(severity)));
        return { severity, reasons, isFakePump: severity >= 70 };
    }

    @Interval(2000)
    async monitorPrices() {
        const openTrades = await this.prismaService.trade.findMany({
            where: { status: 'OPEN', mode: 'LIVE' },
            include: {
                telegramChat: {
                    select: {
                        chatId: true,
                    },
                },
            },
        });

        if (openTrades.length === 0) return;

        // 📦 BATCHING: Get all prices in one go
        const mints = openTrades.map((t) => t.tokenMint);
        const freshMarketDataMap = await this.getBatchFreshMarketData(mints);

        for (const trade of openTrades) {
            if (this.processingTrades.has(trade.id)) continue;

            if (trade.telegramChatId) {
                const chatSettings = await this.telegramWorkspace.getChatSettingsByChatDbId(
                    trade.telegramChatId,
                );
                if (chatSettings?.dryRun ?? true) {
                    this.logger.debug(
                        `[Slot ${trade.slotNumber}] Skipping auto-sell for dry-run chat ${trade.telegramChatId}.`,
                    );
                    continue;
                }
            }

            const freshMarketData = freshMarketDataMap.get(trade.tokenMint);
            const currentPrice = freshMarketData?.priceUsd ?? 0;
            if (currentPrice <= 0) continue;

            this.processingTrades.add(trade.id);
            try {
                await this.evaluateTrade(trade, currentPrice, freshMarketData);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.error(`Error evaluating ${trade.tokenMint}: ${msg}`);
            } finally {
                this.processingTrades.delete(trade.id);
            }
        }
    }

    private getHttpsAgent() {
        return new https.Agent({
            family: 4,
            keepAlive: true,
            lookup: async (hostname, options, cb) => {
                try {
                    const ip = await this.resolveDns(hostname);
                    if (ip) {
                        cb(null, ip, 4);
                    } else {
                        import('dns')
                            .then(({ lookup }) => {
                                lookup(hostname, options, cb);
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

    private async getBatchFreshMarketData(
        mints: string[],
    ): Promise<Map<string, TradeFreshMarketSignals>> {
        const result = new Map<string, TradeFreshMarketSignals>();
        if (mints.length === 0) return result;

        const uniqueMints = [...new Set(mints)].filter((mint) => mint.trim().length > 0);
        if (uniqueMints.length === 0) return result;

        try {
            const response = await DexLimiter.get<DexScreenerBatchResponse>(
                `https://api.dexscreener.com/latest/dex/tokens/${uniqueMints.join(',')}`,
                {
                    timeout: 5000,
                    httpsAgent: this.getHttpsAgent(),
                },
            );

            const pairs = response.data.pairs ?? [];
            for (const mint of uniqueMints) {
                const matchedPair = pairs.find((pair) => pair.baseToken?.address === mint);
                if (!matchedPair) continue;

                const signals = this.extractTradeFreshMarketSignals(matchedPair);
                if (signals) {
                    result.set(mint, signals);
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.debug(`DexScreener batch market snapshot failed: ${message}`);
            return result;
        }

        return result;
    }

    private extractTradeFreshMarketSignals(
        pair: DexScreenerPairWithPriceUsd,
    ): TradeFreshMarketSignals | null {
        const priceUsd = this.parsePriceUsd(pair.priceUsd);
        const liquidityUsd = pair.liquidity?.usd ?? 0;
        const volume5mUsd = pair.volume?.m5 ?? 0;
        const volume1hUsd = pair.volume?.h1 ?? 0;
        const buys5mCount = pair.txns?.m5?.buys ?? 0;
        const sells5mCount = pair.txns?.m5?.sells ?? 0;
        const priceChange1h = pair.priceChange?.h1 ?? 0;
        const averageVolume5m = volume1hUsd / 12;
        const volumeSurge = averageVolume5m > 0 ? volume5mUsd / averageVolume5m : 0;
        const confidenceScore = this.calculateBuyConfidence(buys5mCount, sells5mCount);
        const volScore = liquidityUsd > 0 ? (volume5mUsd / liquidityUsd) * confidenceScore : 0;
        const zScore =
            averageVolume5m > 0
                ? (volume5mUsd - averageVolume5m) / ((averageVolume5m * 0.5) || 1)
                : 0;

        return {
            priceUsd,
            volScore,
            priceChange1h,
            liquidityUsd,
            marketCapUsd: pair.fdv ?? 0,
            volume5mUsd,
            volume1hUsd,
            buys5mCount,
            sells5mCount,
            volumeSurge,
            zScore,
        };
    }

    private async getDexScreenerMarketSnapshot(
        tokenMint: string,
    ): Promise<TradeFreshMarketSignals | null> {
        try {
            const response = await DexLimiter.get<DexScreenerBatchResponse>(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                {
                    timeout: 5000,
                    httpsAgent: this.getHttpsAgent(),
                },
            );

            const pair =
                response.data.pairs?.find((entry) => entry.baseToken?.address === tokenMint) ??
                response.data.pairs?.[0];
            if (!pair) {
                return null;
            }

            return this.extractTradeFreshMarketSignals(pair);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.debug(`DexScreener market snapshot failed for ${tokenMint}: ${message}`);
            return null;
        }
    }

    private parsePriceUsd(priceUsd?: string): number {
        const parsed = Number.parseFloat(priceUsd ?? '');
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }

    private calculateBuyConfidence(buys5m: number, sells5m: number): number {
        const totalTx = buys5m + sells5m;
        if (!Number.isFinite(totalTx) || totalTx <= 0) {
            return 0;
        }

        return buys5m / totalTx;
    }

    private async resolveDns(hostname: string): Promise<string | null> {
        if (this.ipCache[hostname]) return this.ipCache[hostname];
        try {
            let response = await axios
                .get(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
                    headers: { accept: 'application/dns-json' },
                    timeout: 5000,
                    httpsAgent: new https.Agent({ family: 4 }),
                })
                .catch(() => null);

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
                this.ipCache[hostname] = ip;
                return ip;
            }
            const fallbackIp = this.fallbackApiIps[hostname];
            if (fallbackIp) {
                this.logger.warn(
                    `[DNS] Falling back to temporary pinned IP for ${hostname}: ${fallbackIp}`,
                );
                return fallbackIp;
            }
            return null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${hostname}] DNS resolution failed: ${message}. Safety skip.`);
            const fallbackIp = this.fallbackApiIps[hostname];
            if (fallbackIp) {
                this.logger.warn(
                    `[DNS] Falling back to temporary pinned IP for ${hostname}: ${fallbackIp}`,
                );
                return fallbackIp;
            }
            return null;
        }
    }

    private isDynamicHoldZone(profitPercent: number, stopLossPercent: number): boolean {
        if (!Number.isFinite(profitPercent) || !Number.isFinite(stopLossPercent) || stopLossPercent <= 0) {
            return false;
        }

        const halfStopLossDistance = -(stopLossPercent * 0.5);
        return profitPercent <= halfStopLossDistance && profitPercent > -stopLossPercent;
    }

    private getTradeAgeMs(trade: Pick<Trade, 'createdAt'>, nowMs = Date.now()): number {
        const createdAtMs = new Date(trade.createdAt).getTime();
        if (!Number.isFinite(createdAtMs)) return Number.MAX_SAFE_INTEGER;
        return Math.max(0, nowMs - createdAtMs);
    }

    private isEmergencyExitReason(exitReason: string): boolean {
        return ['PANIC_SELL', 'DEV_DUMP', 'RUGPULL', 'AI_HEALTH_CRITICAL'].includes(exitReason);
    }

    private shouldGuardEarlyNonCriticalExit(
        trade: Pick<Trade, 'createdAt'>,
        exitReason: string,
        nowMs = Date.now(),
    ): boolean {
        if (!this.conservativeExitGuardEnabled || this.minNonCriticalHoldMs <= 0) return false;
        if (this.isEmergencyExitReason(exitReason)) return false;
        return this.getTradeAgeMs(trade, nowMs) < this.minNonCriticalHoldMs;
    }

    private shouldRunEarlyExitHealthCheck(exitReason: string): boolean {
        if (exitReason === 'STOP_LOSS') return this.healthCheckBeforeEarlySl;
        if (exitReason === 'TRAILING_STOP') return this.healthCheckBeforeEarlyTrailing;
        return false;
    }

    private async handleEarlyNonCriticalExitGuard(
        trade: TradeWithTelegramChat,
        currentPrice: number,
        exitReason: 'STOP_LOSS' | 'TRAILING_STOP',
        profitPercent: number,
        effectiveStopLossPercent: number,
        signals: TradeFreshMarketSignals,
    ): Promise<boolean> {
        if (!this.shouldGuardEarlyNonCriticalExit(trade, exitReason)) return false;

        const ageSeconds = this.getTradeAgeMs(trade) / 1000;
        const minHoldSeconds = this.minNonCriticalHoldMs / 1000;

        if (this.shouldRunEarlyExitHealthCheck(exitReason)) {
            const healthCheck = await this.shouldHoldOrCut(
                trade,
                profitPercent,
                effectiveStopLossPercent,
                signals,
            );

            if (healthCheck.status === 'CRITICAL') {
                this.logger.warn(
                    `[Slot ${trade.slotNumber}] Early ${exitReason} override: AI Health CRITICAL. age=${ageSeconds.toFixed(1)}s/${minHoldSeconds.toFixed(0)}s pnl=${profitPercent.toFixed(2)}% reentry=${healthCheck.reentrySignal}. reason=${healthCheck.reasoning}`,
                );
                await this.tradeService.executeSell(trade.id, currentPrice, 'AI_HEALTH_CRITICAL');
                return true;
            }

            this.logger.log(
                `[Slot ${trade.slotNumber}] Early ${exitReason} guarded by AI Health HOLD. age=${ageSeconds.toFixed(1)}s/${minHoldSeconds.toFixed(0)}s pnl=${profitPercent.toFixed(2)}% reentry=${healthCheck.reentrySignal}. reason=${healthCheck.reasoning}`,
            );
            return true;
        }

        this.logger.log(
            `[Slot ${trade.slotNumber}] Early ${exitReason} guarded. age=${ageSeconds.toFixed(1)}s/${minHoldSeconds.toFixed(0)}s pnl=${profitPercent.toFixed(2)}%. Waiting for minimum hold window.`,
        );
        return true;
    }
    private estimateFeeDragPercent(
        trade: Pick<Trade, 'entryValueUsd' | 'solPriceAtEntry' | 'totalFeesSol'>,
    ): number {
        const entryValueUsd = Number(trade.entryValueUsd);
        const solPriceAtEntry = Number(trade.solPriceAtEntry);
        if (
            !Number.isFinite(entryValueUsd) ||
            entryValueUsd <= 0 ||
            !Number.isFinite(solPriceAtEntry) ||
            solPriceAtEntry <= 0
        ) {
            return 0;
        }

        const buyFeesSol = Number.isFinite(Number(trade.totalFeesSol))
            ? Math.max(0, Number(trade.totalFeesSol))
            : 0;
        const sellTipSol = this.getBooleanConfig('USE_JITO', false)
            ? Math.max(0, this.getNumberConfig('JITO_TIP_SOL', 0))
            : 0;
        const estimatedSellNetworkFeeSol = Math.max(
            0,
            this.getNumberConfig('ESTIMATED_SELL_NETWORK_FEE_SOL', 0.00001),
        );
        const totalEstimatedFeesUsd =
            (buyFeesSol + sellTipSol + estimatedSellNetworkFeeSol) * solPriceAtEntry;

        // Add the DEX/AMM pool fee + a slippage allowance as a flat % of position; the
        // tip-based term above misses these entirely.
        const dexAndSlippagePercent = this.getNumberConfig('DEX_FEE_ROUNDTRIP_PERCENT', 1.0);
        return (totalEstimatedFeesUsd / entryValueUsd) * 100 + dexAndSlippagePercent;
    }

    private estimateNetProfitPercent(
        trade: Pick<Trade, 'entryValueUsd' | 'solPriceAtEntry' | 'totalFeesSol'>,
        grossProfitPercent: number,
    ): number {
        if (!Number.isFinite(grossProfitPercent)) return grossProfitPercent;
        return grossProfitPercent - this.estimateFeeDragPercent(trade);
    }

    private hasSupportiveFlow(signals: TradeFreshMarketSignals): boolean {
        const buys = Math.max(0, signals.buys5mCount);
        const sells = Math.max(0, signals.sells5mCount);
        const buyPressurePositive = buys >= Math.max(2, sells);
        const volumeStillAlive =
            signals.volumeSurge >= 1 ||
            signals.volScore >= 0.2 ||
            signals.volume5mUsd >= Math.max(100, signals.volume1hUsd * 0.03);
        const trendNotBroken = signals.priceChange1h >= -10;

        return buyPressurePositive && volumeStillAlive && trendNotBroken;
    }

    private async handleTrailingExitHealthGuard(
        trade: TradeWithTelegramChat,
        currentPrice: number,
        profitPercent: number,
        effectiveStopLossPercent: number,
        signals: TradeFreshMarketSignals,
    ): Promise<boolean> {
        if (trade.partialTakeProfitAt) return false;

        const estimatedNetProfitPercent = this.estimateNetProfitPercent(trade, profitPercent);
        const netProfitTooSmall = estimatedNetProfitPercent < this.minNetExitProfitPercent;
        const supportiveFlow = this.hasSupportiveFlow(signals);

        if (!netProfitTooSmall && !supportiveFlow) return false;

        if (this.healthCheckBeforeEarlyTrailing) {
            const healthCheck = await this.shouldHoldOrCut(
                trade,
                profitPercent,
                effectiveStopLossPercent,
                signals,
            );

            if (healthCheck.status === 'CRITICAL') {
                this.logger.warn(
                    `[Slot ${trade.slotNumber}] Trailing override: AI Health CRITICAL. gross=${profitPercent.toFixed(2)}% netEst=${estimatedNetProfitPercent.toFixed(2)}% reason=${healthCheck.reasoning}`,
                );
                await this.tradeService.executeSell(trade.id, currentPrice, 'AI_HEALTH_CRITICAL');
                return true;
            }

            this.logger.log(
                `[Slot ${trade.slotNumber}] Trailing HOLD by health/flow. gross=${profitPercent.toFixed(2)}% netEst=${estimatedNetProfitPercent.toFixed(2)}% minNet=${this.minNetExitProfitPercent}% flow=${supportiveFlow}. reason=${healthCheck.reasoning}`,
            );
            return true;
        }

        if (netProfitTooSmall && supportiveFlow) {
            this.logger.log(
                `[Slot ${trade.slotNumber}] Trailing HOLD by fee-aware flow guard. gross=${profitPercent.toFixed(2)}% netEst=${estimatedNetProfitPercent.toFixed(2)}% minNet=${this.minNetExitProfitPercent}%.`,
            );
            return true;
        }

        return false;
    }

    private async getWatchlistHealthContext(tokenMint: string) {
        return this.prismaService.watchlist.findUnique({
            where: { tokenMint },
            select: {
                isPumpFun: true,
                hasWebsite: true,
                hasTwitter: true,
                hasTelegram: true,
                isDexPaidUpdated: true,
                isCommunityTakeover: true,
                tokenName: true,
                whaleSignalScore: true,
            },
        });
    }

    private async shouldHoldOrCut(
        trade: TradeWithTelegramChat,
        profitPercent: number,
        effectiveStopLossPercent: number,
        signals: TradeFreshMarketSignals,
    ): Promise<AIHealthCheckResult> {
        const now = Date.now();
        const cached = this.healthCheckCache.get(trade.id);
        if (cached && now - cached.checkedAt < 60_000) {
            return cached.result;
        }

        const watchlist = await this.getWatchlistHealthContext(trade.tokenMint);
        const ageHours = (now - new Date(trade.createdAt).getTime()) / (1000 * 60 * 60);
        const route = trade.route === 'WHALE' ? 'WHALE' : 'MICIN';
        const metrics: AIHealthCheckMetrics = {
            ageHours,
            liquidityUsd: signals.liquidityUsd,
            marketCapUsd: signals.marketCapUsd,
            volume5mUsd: signals.volume5mUsd,
            buys5mCount: signals.buys5mCount,
            sells5mCount: signals.sells5mCount,
            priceChange1hPct: signals.priceChange1h,
            isPumpFun: watchlist?.isPumpFun ?? false,
            hasWebsite: watchlist?.hasWebsite ?? false,
            hasTwitter: watchlist?.hasTwitter ?? false,
            hasTelegram: watchlist?.hasTelegram ?? false,
            isDexPaidUpdated: watchlist?.isDexPaidUpdated ?? undefined,
            isCommunityTakeover: watchlist?.isCommunityTakeover ?? undefined,
            tokenName: watchlist?.tokenName ?? trade.symbol ?? undefined,
            whaleSignalScore: watchlist?.whaleSignalScore ?? undefined,
            volumeSurge: signals.volumeSurge,
            volScore: signals.volScore,
            zScore: signals.zScore,
            currentProfitPercent: profitPercent,
            stopLossPercent: effectiveStopLossPercent,
            route,
        };

        const result = await this.aiService.evaluateTokenHealth(
            trade.tokenMint,
            trade.symbol || trade.tokenMint,
            metrics,
        );
        this.healthCheckCache.set(trade.id, { checkedAt: now, result });
        return result;
    }

    private async evaluateTrade(
        trade: TradeWithTelegramChat,
        currentPrice: number,
        freshMarketSignals?: TradeFreshMarketSignals,
    ) {
        const profitPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

        const effectiveStopLossPercent =
            trade.targetStopLoss ??
            this.getRouteNumberConfig(
                trade.route,
                'MICIN_STOP_LOSS_PERCENT',
                'WHALE_STOP_LOSS_PERCENT',
                'STOP_LOSS_PERCENT',
                this.stopLossPercent,
            );
        const normalizedFreshMarketSignals: TradeFreshMarketSignals = {
            priceUsd: freshMarketSignals?.priceUsd ?? currentPrice,
            volScore: freshMarketSignals?.volScore ?? 0,
            priceChange1h: freshMarketSignals?.priceChange1h ?? 0,
            liquidityUsd: freshMarketSignals?.liquidityUsd ?? 0,
            marketCapUsd: freshMarketSignals?.marketCapUsd ?? 0,
            volume5mUsd: freshMarketSignals?.volume5mUsd ?? 0,
            volume1hUsd: freshMarketSignals?.volume1hUsd ?? 0,
            buys5mCount: freshMarketSignals?.buys5mCount ?? 0,
            sells5mCount: freshMarketSignals?.sells5mCount ?? 0,
            volumeSurge: freshMarketSignals?.volumeSurge ?? 0,
            zScore: freshMarketSignals?.zScore ?? 0,
        };
        const noisePressure = this.calculateNoisePressure(normalizedFreshMarketSignals);
        const aiRecommendedTrailingDistance = this.aiService.getRecommendedTrailingDistance(
            normalizedFreshMarketSignals.volScore,
            normalizedFreshMarketSignals.priceChange1h,
        );
        const baseTrailingDistancePercent =
            trade.targetTrailingDistance ??
            this.getRouteNumberConfig(
                trade.route,
                'MICIN_TRAILING_DISTANCE_PERCENT',
                'WHALE_TRAILING_DISTANCE_PERCENT',
                'TRAILING_DISTANCE_PERCENT',
                this.trailingDistancePercent,
            );
        const trailingActivationPercent = this.getRouteNumberConfig(
            trade.route,
            'MICIN_TRAILING_ACTIVATION_PERCENT',
            'WHALE_TRAILING_ACTIVATION_PERCENT',
            'TRAILING_ACTIVATION_PERCENT',
            8,
        );
        const rawNoiseAdjustedTrailingDistance =
            noisePressure.severity >= 85
                ? Math.min(baseTrailingDistancePercent, aiRecommendedTrailingDistance, 1.25)
                : noisePressure.severity >= 70
                  ? Math.min(baseTrailingDistancePercent, aiRecommendedTrailingDistance, 2.0)
                  : noisePressure.severity >= 50
                    ? Math.min(baseTrailingDistancePercent, aiRecommendedTrailingDistance, 3.0)
                    : Math.min(baseTrailingDistancePercent, aiRecommendedTrailingDistance);
        const noiseAdjustedTrailingDistance = trade.partialTakeProfitAt
            ? rawNoiseAdjustedTrailingDistance
            : Math.max(
                  rawNoiseAdjustedTrailingDistance,
                  Math.min(baseTrailingDistancePercent, this.minTrailingDistanceBeforePartialPercent),
              );
        const runnerTrailingMultiplier = trade.partialTakeProfitAt
            ? Math.max(1, this.getNumberConfig('RUNNER_TRAILING_DISTANCE_MULTIPLIER', 2))
            : 1;
        const effectiveTrailingDistancePercent = noiseAdjustedTrailingDistance * runnerTrailingMultiplier;

        this.logger.debug(
            `[Slot ${trade.slotNumber}] Evaluating ${trade.symbol}: Price: $${currentPrice.toFixed(8)}, Profit: ${profitPercent.toFixed(2)}%, SL: -${effectiveStopLossPercent}%, TSL: $${trade.trailingStopPrice.toFixed(8)}`,
        );

        if (effectiveTrailingDistancePercent < baseTrailingDistancePercent) {
            this.logger.warn(
                `[AI Brain] Tightening trailing stop due to high volatility... token=${trade.tokenMint} volScore=${normalizedFreshMarketSignals.volScore.toFixed(4)} priceChange1h=${normalizedFreshMarketSignals.priceChange1h.toFixed(2)}% base=${baseTrailingDistancePercent.toFixed(1)}% effective=${effectiveTrailingDistancePercent.toFixed(1)}%`,
            );
            await this.sendRiskAdjustmentAlertIfNeeded(
                trade,
                currentPrice,
                normalizedFreshMarketSignals,
                baseTrailingDistancePercent,
                effectiveTrailingDistancePercent,
                trade.trailingStopPrice,
                trade.telegramChat?.chatId,
            );
        }

        if (
            noisePressure.isFakePump &&
            profitPercent < 15 &&
            normalizedFreshMarketSignals.buys5mCount <= normalizedFreshMarketSignals.sells5mCount
        ) {
            this.logger.warn(
                `[Slot ${trade.slotNumber}] 🧯 Noise pressure critical for ${trade.tokenMint}. Severity=${noisePressure.severity} Reasons=${noisePressure.reasons.join(',')}. Executing RUGPULL exit.`,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, 'RUGPULL');
            return;
        }

        // 1. ANALISIS HOLDER (Insting Intelijen)
        if (trade.creatorAddress || trade.topHolderAddress) {
            if (trade.creatorAddress) {
                const currentCreatorBalance = await this.tradeService.getTokenBalance(
                    trade.creatorAddress,
                    trade.tokenMint,
                );
                if (typeof currentCreatorBalance === 'number' && trade.initialCreatorBalance) {
                    if (currentCreatorBalance < trade.initialCreatorBalance * 0.8) {
                        // Dev dump > 20% (Lebih sensitif buat modal kecil)
                        this.logger.warn(
                            `[Slot ${trade.slotNumber}] 🔥 EMERGENCY: Developer is dumping! PANIC SELL.`,
                        );
                        await this.tradeService.executeSell(trade.id, currentPrice, 'DEV_DUMP');
                        return;
                    }
                }
            }
            // Top Whale Check (Leniency 15%)
            if (trade.topHolderAddress) {
                const currentTopBalance = await this.tradeService.getTokenBalance(
                    trade.topHolderAddress,
                    trade.tokenMint,
                );
                if (typeof currentTopBalance === 'number' && trade.initialTopHolderBalance) {
                    if (currentTopBalance < trade.initialTopHolderBalance * 0.85) {
                        this.logger.warn(`[Slot ${trade.slotNumber}] 🐋 Whale is dumping!`);
                        // We don't necessarily panic sell on one whale, but we mark it
                    }
                }
            }
        }

        // 2. HARD CRASH BYPASS: instant panic sell with urgent slippage path.
        if (profitPercent <= -55) {
            this.logger.error(
                `[Slot ${trade.slotNumber}] HARD CRASH DETECTED (${profitPercent.toFixed(2)}%). PANIC SELL with 15% slippage.`,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, 'PANIC_SELL');
            return;
        }

        if (this.isDynamicHoldZone(profitPercent, effectiveStopLossPercent)) {
            const healthCheck = await this.shouldHoldOrCut(
                trade,
                profitPercent,
                effectiveStopLossPercent,
                normalizedFreshMarketSignals,
            );

            if (healthCheck.status === 'CRITICAL') {
                this.logger.warn(
                    `[Slot ${trade.slotNumber}] AI Health CRITICAL before full SL. pnl=${profitPercent.toFixed(2)}% sl=${effectiveStopLossPercent}% reentry=${healthCheck.reentrySignal}. reason=${healthCheck.reasoning}`,
                );
                await this.tradeService.executeSell(trade.id, currentPrice, 'AI_HEALTH_CRITICAL');
                return;
            }

            this.logger.log(
                `[Slot ${trade.slotNumber}] AI Health HOLD. pnl=${profitPercent.toFixed(2)}% sl=${effectiveStopLossPercent}% reentry=${healthCheck.reentrySignal}. reason=${healthCheck.reasoning}`,
            );
            return;
        }

        // Route-aware stop loss remains the hard floor after the dynamic hold zone is exhausted.
        if (profitPercent <= -effectiveStopLossPercent) {
            if (
                await this.handleEarlyNonCriticalExitGuard(
                    trade,
                    currentPrice,
                    'STOP_LOSS',
                    profitPercent,
                    effectiveStopLossPercent,
                    normalizedFreshMarketSignals,
                )
            ) {
                return;
            }

            this.logger.warn(
                `[Slot ${trade.slotNumber}] STOP_LOSS hard floor reached. route=${trade.route ?? 'GLOBAL'} pnl=${profitPercent.toFixed(2)}% sl=${effectiveStopLossPercent}%`,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, 'STOP_LOSS');
            return;
        }
        // 3. TRAILING STOP LOGIC (Update Peak & TSL)
        // 🚀 Hanya update peak kalau harga sudah naik minimal 5% (Safe Zone)
        if (currentPrice > trade.highestPrice && profitPercent >= trailingActivationPercent) {
            const calculatedStop = currentPrice * (1 - effectiveTrailingDistancePercent / 100);

            // Jarak trailing stop murni dari peak tanpa floor buatan di awal
            let newTrailingStop = calculatedStop;

            // 🛡️ BREAK-EVEN PROTECTION: lock a floor that actually covers round-trip fees,
            // not a cosmetic +2%. Uses the fee-aware estimate when available, else config.
            if (profitPercent >= 15) {
                const feeDragPercent = this.estimateFeeDragPercent(trade);
                const marginPercent = this.getNumberConfig('BREAKEVEN_MARGIN_PERCENT', 2);
                const configFloorPercent = this.getNumberConfig('RUNNER_BREAKEVEN_FLOOR_PERCENT', 8);
                const floorPercent = Math.max(feeDragPercent + marginPercent, configFloorPercent);
                const breakEvenPlus = trade.entryPrice * (1 + floorPercent / 100);
                newTrailingStop = Math.max(newTrailingStop, breakEvenPlus);
            }

            await this.prismaService.trade.update({
                where: { id: trade.id },
                data: { highestPrice: currentPrice, trailingStopPrice: newTrailingStop },
            });
            this.logger.debug(
                `[Slot ${trade.slotNumber}] 📈 New Peak: $${currentPrice.toFixed(8)}. TSL Locked at: $${newTrailingStop.toFixed(8)}`,
            );

            // Anti-Spam Trailing Alert
            const now = Date.now();
            const lastAlert = this.lastAlertTime.get(trade.tokenMint) || 0;
            if (profitPercent >= trailingActivationPercent && now - lastAlert > 5 * 60 * 1000) {
                await this.reportingService.sendTrailingAlert(
                    trade.tokenMint,
                    newTrailingStop,
                    currentPrice,
                    trade.symbol || undefined,
                );
                this.lastAlertTime.set(trade.tokenMint, now);
            }
        } else if (
            effectiveTrailingDistancePercent < baseTrailingDistancePercent &&
            trade.trailingStopPrice > 0
        ) {
            const referencePrice = Math.max(trade.highestPrice, currentPrice);
            const tightenedTrailingStop =
                referencePrice * (1 - effectiveTrailingDistancePercent / 100);

            if (tightenedTrailingStop > trade.trailingStopPrice) {
                await this.prismaService.trade.update({
                    where: { id: trade.id },
                    data: { trailingStopPrice: tightenedTrailingStop },
                });
                this.logger.warn(
                    `[AI Brain] Tightening trailing stop realtime for ${trade.tokenMint}. Reference=$${referencePrice.toFixed(8)} NewTSL=$${tightenedTrailingStop.toFixed(8)}.`,
                );
                await this.sendRiskAdjustmentAlertIfNeeded(
                    trade,
                    referencePrice,
                    normalizedFreshMarketSignals,
                    baseTrailingDistancePercent,
                    effectiveTrailingDistancePercent,
                    tightenedTrailingStop,
                    trade.telegramChat?.chatId,
                );
            }
        }

        // 4. EXIT CONDITION: Take Profit or Trailing Stop
        const baseTP =
            trade.targetTakeProfit ??
            this.getRouteNumberConfig(
                trade.route,
                'MICIN_TAKE_PROFIT_PERCENT',
                'WHALE_TAKE_PROFIT_PERCENT',
                'TAKE_PROFIT_PERCENT',
                15,
            );
        // 🚀 DYNAMIC TP: Kalau volume lagi "Sakit" (Surge gede), targetin lebih tinggi
        // Kita butuh volumeSurge dari database (Watchlist) kalau ada, atau kita asumsikan dari momentum
        // Untuk sekarang kita pake multiplier kalau highestPrice naik kenceng
        let dynamicTP = baseTP;
        const effectiveHighestPrice = Math.max(trade.highestPrice, currentPrice);
        if (profitPercent >= baseTP && effectiveHighestPrice > trade.entryPrice * 1.35) {
            this.logger.log(
                `[Slot ${trade.slotNumber}] 🔥 HIGH MOMENTUM DETECTED! Increasing TP target to 50%...`,
            );
            dynamicTP = 50.0; // Target lebih realistis untuk microcap
        }

        // Trigger one partial TP first, then let the remaining position ride with trailing stop.
        if (profitPercent >= dynamicTP && !trade.partialTakeProfitAt) {
            this.logger.log(
                `[Slot ${trade.slotNumber}] 🎯 TARGET HIT! Taking 50% profit at ${profitPercent.toFixed(2)}%, keeping the rest on trailing stop.`,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, 'PARTIAL_TAKE_PROFIT', 0.5);
            return;
        }

        // Trailing Stop Trigger
        if (trade.trailingStopPrice > 0 && currentPrice <= trade.trailingStopPrice) {
            const reason = 'TRAILING_STOP';
            if (
                await this.handleEarlyNonCriticalExitGuard(
                    trade,
                    currentPrice,
                    reason,
                    profitPercent,
                    effectiveStopLossPercent,
                    normalizedFreshMarketSignals,
                )
            ) {
                return;
            }

            if (
                await this.handleTrailingExitHealthGuard(
                    trade,
                    currentPrice,
                    profitPercent,
                    effectiveStopLossPercent,
                    normalizedFreshMarketSignals,
                )
            ) {
                return;
            }

            this.logger.log(
                `[Slot ${trade.slotNumber}] ${reason} at $${currentPrice.toFixed(8)} (Profit: ${profitPercent.toFixed(2)}%)`,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, reason);
            return;
        }
        // NOTE: the former "Patience Protocol" SL-hold block lived here. It was unreachable
        // dead code — the hard-floor STOP_LOSS check above (profitPercent <= -effectiveStopLossPercent)
        // always handles and returns for that condition first — so it was removed.
    }

    private async checkBuyPressure(tokenMint: string): Promise<boolean> {
        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
            interface DexPair {
                txns?: {
                    m5?: {
                        buys?: number;
                        sells?: number;
                    };
                };
            }
            const response = await DexLimiter.get<{ pairs: DexPair[] }>(url, {
                httpsAgent: this.getHttpsAgent(),
                timeout: 5000,
            });

            const pair = response.data.pairs?.[0];
            if (!pair?.txns?.m5) return false;

            const buys = pair.txns.m5.buys || 0;
            const sells = pair.txns.m5.sells || 0;

            // Jika pembeli > 2x penjual dalam 5 menit terakhir, berarti ada tekanan beli kuat
            if (buys > sells * 2 && buys > 5) {
                return true;
            }

            return false;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to check buy pressure: ${msg}`);
            return false;
        }
    }

    private async sendRiskAdjustmentAlertIfNeeded(
        trade: Trade,
        currentPrice: number,
        signals: TradeFreshMarketSignals,
        baseTrailingDistancePercent: number,
        effectiveTrailingDistancePercent: number,
        newTrailingStop: number,
        targetChatId?: string,
    ): Promise<void> {
        try {
            const now = Date.now();
            const lastAlertAt = this.lastRiskAdjustmentAlertTime.get(trade.tokenMint) || 0;
            if (now - lastAlertAt < 5 * 60 * 1000) {
                return;
            }

            await this.reportingService.sendRiskAdjustmentAlert({
                tokenMint: trade.tokenMint,
                symbol: trade.symbol || undefined,
                currentPrice,
                newTrailingStop,
                baseTrailingDistancePercent,
                effectiveTrailingDistancePercent,
                volScore: signals.volScore,
                priceChange1h: signals.priceChange1h,
                targetChatId,
            });
            this.lastRiskAdjustmentAlertTime.set(trade.tokenMint, now);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `[AI Brain] Failed to send risk adjustment alert for ${trade.tokenMint}: ${message}`,
            );
        }
    }
}






