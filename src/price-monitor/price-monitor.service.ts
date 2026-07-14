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
import { selectBestDexScreenerPair } from '../common/dex-pair';
import { AIService } from '../ai/ai.service';
import { TelegramWorkspaceService } from '../telegram/telegram-workspace.service';
import { DexScreenerPair } from '../dto/analyzer.dto';
import { AICutlossDefenseMetrics, AIHealthCheckMetrics, AIHealthCheckResult } from '../dto/ai.dto';

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

export interface MonitorSolPriceBasis {
    currentPriceSol: number;
    entryPriceSol: number;
    highestPriceSol: number;
    trailingStopPriceSol: number;
    currentSolUsd: number;
    basis: 'sol' | 'legacy_usd_converted';
}

export interface CreatorDumpCheckResult {
    detected: boolean;
    dumpPercent: number | null;
}

export function detectCreatorDump(
    initialCreatorBalance: unknown,
    currentCreatorBalance: unknown,
    thresholdPercent = 20,
): CreatorDumpCheckResult {
    const initial = Number(initialCreatorBalance);
    const current = Number(currentCreatorBalance);
    if (!Number.isFinite(initial) || initial <= 0 || !Number.isFinite(current)) {
        return { detected: false, dumpPercent: null };
    }

    const threshold = Math.min(100, Math.max(0, Number(thresholdPercent))) / 100;
    const dumpPercent = Math.max(0, (1 - current / initial) * 100);
    return {
        detected: current < initial * (1 - threshold),
        dumpPercent,
    };
}

export function resolveMonitorSolPriceBasis(params: {
    currentPriceUsd: number;
    currentSolUsd: number;
    entryPrice: number;
    highestPrice: number;
    trailingStopPrice: number;
    solPriceAtEntry?: number | null;
}): MonitorSolPriceBasis | null {
    const currentPriceUsd = Number(params.currentPriceUsd);
    const currentSolUsd = Number(params.currentSolUsd);
    const solPriceAtEntry = Number(params.solPriceAtEntry ?? 0);
    if (!Number.isFinite(currentPriceUsd) || currentPriceUsd <= 0) return null;
    if (!Number.isFinite(currentSolUsd) || currentSolUsd <= 0) return null;

    const currentPriceSol = currentPriceUsd / currentSolUsd;
    const fallbackSolUsd =
        Number.isFinite(solPriceAtEntry) && solPriceAtEntry > 0 ? solPriceAtEntry : currentSolUsd;
    const toSolBasis = (value: number): { value: number; legacy: boolean } => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) return { value: 0, legacy: false };
        const looksLikeUsd = numeric > currentPriceSol * 10;
        return looksLikeUsd
            ? { value: numeric / fallbackSolUsd, legacy: true }
            : { value: numeric, legacy: false };
    };

    const entry = toSolBasis(params.entryPrice);
    const highest = toSolBasis(params.highestPrice);
    const trailing = toSolBasis(params.trailingStopPrice);
    const entryPriceSol = entry.value > 0 ? entry.value : currentPriceSol;

    return {
        currentPriceSol,
        entryPriceSol,
        highestPriceSol: highest.value > 0 ? highest.value : entryPriceSol,
        trailingStopPriceSol: trailing.value,
        currentSolUsd,
        basis: entry.legacy || highest.legacy || trailing.legacy ? 'legacy_usd_converted' : 'sol',
    };
}

@Injectable()
export class PriceMonitorService {
    private readonly logger = new Logger(PriceMonitorService.name);
    private trailingDistancePercent: number;
    private jupiterApiKey: string;
    private stopLossPercent: number;
    private readonly conservativeExitGuardEnabled: boolean;
    private readonly minNonCriticalHoldMs: number;
    private readonly healthCheckBeforeEarlySl: boolean;
    private readonly healthCheckBeforeEarlyTrailing: boolean;
    private readonly minNetExitProfitPercent: number;
    private readonly minTrailingDistanceBeforePartialPercent: number;
    private readonly enableDynamicHoldZone: boolean;
    private readonly dynamicHoldZoneMaxMs: number;
    private readonly stopLossGuardDepthFloorPercent: number;
    private readonly enableAiCutlossDefense: boolean;
    private readonly devDumpThresholdRatio: number;
    private readonly aiCutlossMaxExtensionPercent: number;
    private readonly aiCutlossHardFloorPercent: number;
    private readonly aiCutlossMaxDefensesPerTrade: number;
    private readonly aiCutlossMinConfidence: 'high' | 'medium' | 'low';
    // Verifier MINOR fix: tunable via config like every other threshold in this constructor,
    // instead of a hardcoded literal buried in the batch loop.
    private readonly monitorConcurrencyLimit: number;
    // FIX C1: first-entered timestamp per trade.id while sitting in the dynamic hold zone,
    // so a position can't be held there indefinitely on repeated AI "non-critical" reads.
    private readonly dynamicHoldZoneEnteredAt = new Map<number, number>();
    // Verifier MAJOR fix: keyed by trade.id, not tokenMint — two different chats can each
    // hold their own OPEN LIVE trade on the same tokenMint (trade.service.ts scopes the
    // duplicate-open-trade guard by telegramChatId), so a tokenMint key let one trade's
    // cooldown suppress another trade's alert entirely.
    private readonly lastAlertTime = new Map<number, number>(); // Cooldown alert: trade.id -> timestamp
    private readonly lastRiskAdjustmentAlertTime = new Map<number, number>(); // trade.id -> timestamp
    private readonly healthCheckCache = new Map<
        number,
        { checkedAt: number; result: AIHealthCheckResult }
    >();
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
        this.conservativeExitGuardEnabled = this.getBooleanConfig(
            'ENABLE_CONSERVATIVE_EXIT_GUARD',
            true,
        );
        this.minNonCriticalHoldMs = Math.max(
            0,
            this.getNumberConfig('MIN_NON_CRITICAL_HOLD_SECONDS', 60) * 1000,
        );
        this.healthCheckBeforeEarlySl = this.getBooleanConfig('HEALTH_CHECK_BEFORE_EARLY_SL', true);
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
        this.enableDynamicHoldZone = this.getBooleanConfig('ENABLE_DYNAMIC_HOLD_ZONE', true);
        this.dynamicHoldZoneMaxMs = Math.max(
            0,
            this.getNumberConfig('DYNAMIC_HOLD_ZONE_MAX_SECONDS', 60) * 1000,
        );
        // Verifier MAJOR fix: 20 collided exactly with the hard-coded targetStopLoss=20.0 used
        // by the "Established Rebound & CTO" route (established-analyzer.service.ts), making the
        // STOP_LOSS branch (which only fires once profitPercent <= -effectiveStopLossPercent)
        // trivially satisfy this depth-floor bypass every time for that route — unconditionally
        // nullifying the FIX C2 guard for it. 30 keeps a real margin above every known route SL
        // (GLOBAL/MICIN=13, WHALE=10, Established=20) so the guard stays meaningful there too.
        this.stopLossGuardDepthFloorPercent = Math.max(
            0,
            this.getNumberConfig('STOP_LOSS_GUARD_DEPTH_FLOOR_PERCENT', 30),
        );
        this.enableAiCutlossDefense = this.getBooleanConfig('ENABLE_AI_CUTLOSS_DEFENSE', false);
        this.devDumpThresholdRatio = Math.min(
            1,
            Math.max(0, this.getNumberConfig('DEV_DUMP_THRESHOLD_PERCENT', 20) / 100),
        );
        this.aiCutlossMaxExtensionPercent = Math.max(
            0,
            this.getNumberConfig('AI_CUTLOSS_MAX_EXTENSION_PERCENT', 10),
        );
        this.aiCutlossHardFloorPercent = Math.max(
            this.stopLossPercent,
            this.getNumberConfig('AI_CUTLOSS_HARD_FLOOR_PERCENT', 45),
        );
        this.aiCutlossMaxDefensesPerTrade = Math.max(
            0,
            Math.floor(this.getNumberConfig('AI_CUTLOSS_MAX_DEFENSES_PER_TRADE', 1)),
        );
        this.aiCutlossMinConfidence = this.getConfidenceConfig(
            'AI_CUTLOSS_MIN_CONFIDENCE',
            'medium',
        );
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
        this.monitorConcurrencyLimit = Math.max(
            1,
            Math.floor(this.getNumberConfig('PRICE_MONITOR_CONCURRENCY_LIMIT', 3)),
        );
    }

    private getBooleanConfig(key: string, fallback: boolean): boolean {
        const raw = this.configService.get<string>(key, String(fallback));
        if (typeof raw === 'boolean') return raw;
        const normalized = String(raw).trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
        return fallback;
    }

    private getConfidenceConfig(
        key: string,
        fallback: 'high' | 'medium' | 'low',
    ): 'high' | 'medium' | 'low' {
        const raw = String(this.configService.get<string>(key, fallback)).trim().toLowerCase();
        return raw === 'high' || raw === 'medium' || raw === 'low' ? raw : fallback;
    }

    private confidenceRank(value: 'high' | 'medium' | 'low'): number {
        if (value === 'high') return 3;
        if (value === 'medium') return 2;
        return 1;
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
    // FIX B2: consecutive-ticks-without-a-price counter per trade, so a trade that
    // silently stops receiving fresh prices (stop-loss/trailing can't be evaluated)
    // is escalated instead of skipped forever with no trace.
    private readonly priceMissCounts = new Map<number, number>();

    private calculateNoisePressure(signals: TradeFreshMarketSignals): {
        severity: number;
        reasons: string[];
        isFakePump: boolean;
    } {
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

        const sellPressure =
            signals.sells5mCount > signals.buys5mCount * 1.1 && signals.sells5mCount >= 5;
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

    @Interval(1000)
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

        // FIX (verifier MINOR): a trade that leaves OPEN status while mid-outage (sold,
        // closed, etc. via a path other than the fresh-price success branch below) never
        // reappears in openTrades again, so its priceMissCounts entry would otherwise never
        // be released. Prune against the current OPEN snapshot every tick — including when
        // openTrades is empty — instead of relying solely on the delete() below.
        if (
            this.priceMissCounts.size > 0 ||
            this.dynamicHoldZoneEnteredAt.size > 0 ||
            this.lastAlertTime.size > 0 ||
            this.lastRiskAdjustmentAlertTime.size > 0
        ) {
            const openTradeIds = new Set(openTrades.map((t) => t.id));
            for (const id of this.priceMissCounts.keys()) {
                if (!openTradeIds.has(id)) this.priceMissCounts.delete(id);
            }
            // FIX C1: a trade that leaves OPEN status (sold, closed, etc.) must not keep
            // occupying a dynamic-hold-zone timer entry forever.
            for (const id of this.dynamicHoldZoneEnteredAt.keys()) {
                if (!openTradeIds.has(id)) this.dynamicHoldZoneEnteredAt.delete(id);
            }
            // Verifier MAJOR fix: lastAlertTime/lastRiskAdjustmentAlertTime were re-keyed from
            // tokenMint to trade.id (a Prisma autoincrement Int) but never pruned -- every closed
            // trade left a permanent dead entry, an unbounded memory leak for the life of the
            // process. Prune both against the same fresh OPEN snapshot used above.
            for (const id of this.lastAlertTime.keys()) {
                if (!openTradeIds.has(id)) this.lastAlertTime.delete(id);
            }
            for (const id of this.lastRiskAdjustmentAlertTime.keys()) {
                if (!openTradeIds.has(id)) this.lastRiskAdjustmentAlertTime.delete(id);
            }
        }

        if (openTrades.length === 0) return;

        // 📦 BATCHING: Get all prices in one go
        const mints = openTrades.map((t) => t.tokenMint);
        const freshMarketDataMap = await this.getBatchFreshMarketData(mints);

        // FIX B3: fetch SOL/USD at most once per tick (not once per trade) — evaluateTrade
        // no longer hits the Jupiter price endpoint per-trade, per-tick. Fetched lazily (only
        // once a trade actually reaches evaluation) so a tick where every trade is dry-run or
        // price-missing never calls Jupiter at all.
        // FIX A4b: cache the in-flight PROMISE (not just the resolved value), so concurrent
        // trades within the same batch that race into this function before it resolves all
        // share the single in-flight request instead of each firing their own call.
        let cachedSolPriceUsdPromise: Promise<number> | null = null;
        const getSolPriceUsdForTick = (): Promise<number> => {
            if (cachedSolPriceUsdPromise === null) {
                cachedSolPriceUsdPromise = this.tradeService.getSolPrice();
            }
            return cachedSolPriceUsdPromise;
        };

        // FIX A4b: evaluate trades within a tick with small bounded concurrency instead of
        // strictly sequentially, so one slow trade (stuck sell retry, slow AI health-check
        // call) doesn't block the rest of the tick's trades behind it. Concurrency is capped
        // (not unbounded) because per-trade external calls (RPC balance checks in
        // evaluateTrade, AI health-check calls) are not behind any shared rate limiter.
        // Promise.all is safe here: the ENTIRE body of the mapped callback below (including
        // the processingTrades claim, not just the per-trade evaluation logic) is wrapped in
        // the outer try/catch immediately below, so the mapped promise structurally cannot
        // reject -- this no longer depends on every branch individually remembering to catch
        // its own errors. A future edit would have to deliberately move code outside this
        // outer try for Promise.all's fail-fast semantics to resurface.
        for (let i = 0; i < openTrades.length; i += this.monitorConcurrencyLimit) {
            const batch = openTrades.slice(i, i + this.monitorConcurrencyLimit);
            await Promise.all(
                batch.map(async (trade) => {
                    try {
                        if (this.processingTrades.has(trade.id)) return;
                        // FIX A4a: claim the slot synchronously, right after the has() check and
                        // before any await, so an overlapping @Interval(1000) tick can't also
                        // pass has() for the same trade while this iteration is still awaiting.
                        this.processingTrades.add(trade.id);
                        try {
                            if (trade.telegramChatId) {
                                const chatSettings =
                                    await this.telegramWorkspace.getChatSettingsByChatDbId(
                                        trade.telegramChatId,
                                    );
                                if (chatSettings?.dryRun ?? true) {
                                    this.logger.debug(
                                        `[Slot ${trade.slotNumber}] Skipping auto-sell for dry-run chat ${trade.telegramChatId}.`,
                                    );
                                    return;
                                }
                            }

                            const freshMarketData = freshMarketDataMap.get(trade.tokenMint);
                            const currentPrice = freshMarketData?.priceUsd ?? 0;
                            if (currentPrice <= 0) {
                                // FIX B2: upgrade the silent skip to a visible, escalating signal.
                                const misses = (this.priceMissCounts.get(trade.id) || 0) + 1;
                                this.priceMissCounts.set(trade.id, misses);
                                this.logger.warn(
                                    `[Slot ${trade.slotNumber}] No fresh price for ${trade.tokenMint}: ${misses} consecutive miss(es). Stop-loss/trailing evaluation skipped this tick.`,
                                );

                                const alertThreshold = Number.parseInt(
                                    this.configService.get<string>(
                                        'PRICE_MISS_ALERT_AFTER_TICKS',
                                        '3',
                                    ),
                                    10,
                                );
                                const threshold =
                                    Number.isFinite(alertThreshold) && alertThreshold > 0
                                        ? alertThreshold
                                        : 3;
                                // FIX (verifier MINOR): re-escalate every `threshold` ticks instead of firing
                                // exactly once for the entire outage — a 10-minute gap should keep alerting,
                                // not go quiet after the first ping.
                                if (misses >= threshold && misses % threshold === 0) {
                                    try {
                                        await this.reportingService.sendPriceMissAlert({
                                            tokenMint: trade.tokenMint,
                                            symbol: trade.symbol || undefined,
                                            misses,
                                            reason: `price_miss_x${misses}: no fresh market price for ${misses} consecutive ticks`,
                                            details:
                                                'Trade has gone dark: stop-loss/trailing-stop cannot be evaluated without a live price. Check DexScreener/RPC health.',
                                            targetChatId: trade.telegramChat?.chatId,
                                        });
                                    } catch (alertErr) {
                                        const msg =
                                            alertErr instanceof Error
                                                ? alertErr.message
                                                : String(alertErr);
                                        this.logger.error(
                                            `[Trade ${trade.id}] Failed to send price-miss alert: ${msg}`,
                                        );
                                    }
                                }
                                return;
                            }
                            this.priceMissCounts.delete(trade.id);

                            const solPriceUsd = await getSolPriceUsdForTick();
                            await this.evaluateTrade(
                                trade,
                                currentPrice,
                                solPriceUsd,
                                freshMarketData,
                            );
                        } finally {
                            this.processingTrades.delete(trade.id);
                        }
                    } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        this.logger.error(`Error evaluating ${trade.tokenMint}: ${msg}`);
                    }
                }),
            );
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
                const matchedPair = selectBestDexScreenerPair(pairs, mint);
                if (!matchedPair) continue;

                const signals = this.extractTradeFreshMarketSignals(matchedPair);
                if (signals) {
                    result.set(mint, signals);
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // FIX B2: this failure silently starves every open trade of a price this
            // tick (falls through to the per-trade currentPrice <= 0 skip) — make it
            // visible at warn, not debug.
            this.logger.warn(`DexScreener batch market snapshot failed: ${message}`);
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
                ? (volume5mUsd - averageVolume5m) / (averageVolume5m * 0.5 || 1)
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

            const pair = selectBestDexScreenerPair(response.data.pairs, tokenMint);
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
        if (
            !Number.isFinite(profitPercent) ||
            !Number.isFinite(stopLossPercent) ||
            stopLossPercent <= 0
        ) {
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
        profitPercent: number,
        nowMs = Date.now(),
    ): boolean {
        if (!this.conservativeExitGuardEnabled || this.minNonCriticalHoldMs <= 0) return false;
        if (this.isEmergencyExitReason(exitReason)) return false;
        // FIX C2: depth floor — never guard a STOP_LOSS past a configurable loss depth,
        // regardless of trade age. This does NOT exempt STOP_LOSS from the guard entirely;
        // it only stops the guard once the position is deep enough that fee-churn protection
        // is no longer the relevant concern.
        if (
            exitReason === 'STOP_LOSS' &&
            Number.isFinite(profitPercent) &&
            profitPercent <= -this.stopLossGuardDepthFloorPercent
        ) {
            return false;
        }
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
        if (!this.shouldGuardEarlyNonCriticalExit(trade, exitReason, profitPercent)) return false;

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
        // Mirror the execution-side Jito gate: the sell tip is only paid when the sell
        // notional clears JITO_MIN_POSITION_USD. Counting it on sub-threshold positions
        // would inflate fee drag and over-hold small winners.
        const sellUsesJito =
            this.getBooleanConfig('USE_JITO', false) &&
            entryValueUsd >= this.getNumberConfig('JITO_MIN_POSITION_USD', 7);
        const sellTipSol = sellUsesJito ? Math.max(0, this.getNumberConfig('JITO_TIP_SOL', 0)) : 0;
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

    private async handleAiCutlossDefense(
        trade: TradeWithTelegramChat,
        currentPrice: number,
        currentSolUsd: number,
        profitPercent: number,
        effectiveStopLossPercent: number,
        fallbackSignals: TradeFreshMarketSignals,
    ): Promise<boolean> {
        if (!this.enableAiCutlossDefense || this.aiCutlossMaxDefensesPerTrade <= 0) return false;

        const currentLossDepthPercent = Math.max(0, -profitPercent);
        if (currentLossDepthPercent >= this.aiCutlossHardFloorPercent) {
            this.logger.warn(
                `[Slot ${trade.slotNumber}] AI cutloss defense bypassed: hard floor reached. loss=${currentLossDepthPercent.toFixed(2)}% hardFloor=${this.aiCutlossHardFloorPercent}%`,
            );
            return false;
        }

        const defenseCount = Math.max(0, trade.aiCutlossDefenseCount ?? 0);
        if (defenseCount >= this.aiCutlossMaxDefensesPerTrade) {
            this.logger.warn(
                `[Slot ${trade.slotNumber}] AI cutloss defense bypassed: max defenses reached. count=${defenseCount}/${this.aiCutlossMaxDefensesPerTrade}`,
            );
            return false;
        }

        try {
            const refreshedSignals = await this.getDexScreenerMarketSnapshot(trade.tokenMint);
            const signals = refreshedSignals ?? fallbackSignals;
            const refreshedPrice = signals.priceUsd > 0 ? signals.priceUsd : currentPrice;
            const refreshedBasis = resolveMonitorSolPriceBasis({
                currentPriceUsd: refreshedPrice,
                currentSolUsd,
                entryPrice: trade.entryPrice,
                highestPrice: trade.highestPrice,
                trailingStopPrice: trade.trailingStopPrice,
                solPriceAtEntry: trade.solPriceAtEntry,
            });

            if (!refreshedBasis) {
                this.logger.warn(
                    `[Slot ${trade.slotNumber}] AI cutloss defense could not resolve refreshed price basis. Fail-closing with STOP_LOSS.`,
                );
                await this.tradeService.executeSell(trade.id, currentPrice, 'STOP_LOSS');
                return true;
            }

            const refreshedProfitPercent =
                ((refreshedBasis.currentPriceSol - refreshedBasis.entryPriceSol) /
                    refreshedBasis.entryPriceSol) *
                100;
            if (refreshedProfitPercent > -effectiveStopLossPercent) {
                this.logger.log(
                    `[Slot ${trade.slotNumber}] AI cutloss defense refreshed price recovered above SL. oldPnl=${profitPercent.toFixed(2)}% freshPnl=${refreshedProfitPercent.toFixed(2)}%. Holding without AI call.`,
                );
                return true;
            }

            const watchlist = await this.getWatchlistHealthContext(trade.tokenMint);
            const ageHours = (Date.now() - new Date(trade.createdAt).getTime()) / (1000 * 60 * 60);
            const route = trade.route === 'WHALE' ? 'WHALE' : 'MICIN';
            const metrics: AICutlossDefenseMetrics = {
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
                currentProfitPercent: refreshedProfitPercent,
                stopLossPercent: effectiveStopLossPercent,
                route,
                entryPriceUsd: refreshedBasis.entryPriceSol * currentSolUsd,
                currentPriceUsd: refreshedPrice,
                highestPriceUsd:
                    Math.max(refreshedBasis.highestPriceSol, refreshedBasis.currentPriceSol) *
                    currentSolUsd,
                trailingStopPriceUsd: refreshedBasis.trailingStopPriceSol * currentSolUsd,
                currentLossDepthPercent: Math.max(0, -refreshedProfitPercent),
                defenseCount,
                maxExtensionPercent: this.aiCutlossMaxExtensionPercent,
                hardFloorPercent: this.aiCutlossHardFloorPercent,
            };

            const decision = await this.aiService.evaluateCutlossDefense(
                trade.tokenMint,
                trade.symbol || trade.tokenMint,
                metrics,
            );
            const minimumConfidence = this.confidenceRank(this.aiCutlossMinConfidence);
            const decisionConfidence = this.confidenceRank(decision.confidenceLevel);

            if (
                decision.action === 'EXTEND_CUTLOSS' &&
                decision.newStopLossPercent !== undefined &&
                decisionConfidence >= minimumConfidence
            ) {
                const boundedStopLoss = Math.min(
                    this.aiCutlossHardFloorPercent,
                    Math.max(
                        effectiveStopLossPercent + 0.01,
                        Math.min(
                            effectiveStopLossPercent + this.aiCutlossMaxExtensionPercent,
                            decision.newStopLossPercent,
                        ),
                    ),
                );
                if (boundedStopLoss > effectiveStopLossPercent) {
                    await this.prismaService.trade.updateMany({
                        where: { id: trade.id, status: 'OPEN' },
                        data: {
                            targetStopLoss: boundedStopLoss,
                            aiCutlossDefenseCount: { increment: 1 },
                            aiCutlossLastAt: new Date(),
                            aiCutlossReason: decision.reasoning,
                        },
                    });
                    this.logger.warn(
                        `[Slot ${trade.slotNumber}] AI cutloss defense EXTEND. tradeId=${trade.id} pnl=${refreshedProfitPercent.toFixed(2)}% oldSL=${effectiveStopLossPercent}% newSL=${boundedStopLoss}% confidence=${decision.confidenceLevel} reason=${decision.reasoning}`,
                    );
                    return true;
                }
            }

            this.logger.warn(
                `[Slot ${trade.slotNumber}] AI cutloss defense SELL. tradeId=${trade.id} pnl=${refreshedProfitPercent.toFixed(2)}% action=${decision.action} confidence=${decision.confidenceLevel} min=${this.aiCutlossMinConfidence} reason=${decision.reasoning}`,
            );
            await this.tradeService.executeSell(trade.id, refreshedPrice, 'AI_STOP_LOSS_CONFIRMED');
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(
                `[Slot ${trade.slotNumber}] AI cutloss defense failed; fail-closing with STOP_LOSS. ${message}`,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, 'STOP_LOSS');
            return true;
        }
    }
    private async persistExitTrigger(
        tradeId: number,
        currentPriceSol: number,
        currentSolUsd: number,
        profitPercent: number,
    ): Promise<void> {
        await this.prismaService.trade.updateMany({
            where: { id: tradeId, exitTriggerPnlPercent: null },
            data: {
                exitTriggerPriceSol: currentPriceSol,
                exitTriggerPriceUsd: currentPriceSol * currentSolUsd,
                exitTriggerPnlPercent: profitPercent,
            },
        });
    }

    private async evaluateTrade(
        trade: TradeWithTelegramChat,
        currentPrice: number,
        solPriceUsd: number,
        freshMarketSignals?: TradeFreshMarketSignals,
    ) {
        // FIX B3: solPriceUsd is fetched at most once per tick (lazily, on first use) by
        // monitorPrices() instead of being fetched here per-trade, per-tick.
        const currentSolUsd = solPriceUsd;
        const priceBasis = resolveMonitorSolPriceBasis({
            currentPriceUsd: currentPrice,
            currentSolUsd,
            entryPrice: trade.entryPrice,
            highestPrice: trade.highestPrice,
            trailingStopPrice: trade.trailingStopPrice,
            solPriceAtEntry: trade.solPriceAtEntry,
        });
        if (!priceBasis) {
            this.logger.warn(
                `[Slot ${trade.slotNumber}] Unable to resolve SOL price basis for ${trade.tokenMint}. Skipping exit evaluation.`,
            );
            return;
        }
        const currentPriceSol = priceBasis.currentPriceSol;
        const entryPriceSol = priceBasis.entryPriceSol;
        const highestPriceSol = priceBasis.highestPriceSol;
        const trailingStopPriceSol = priceBasis.trailingStopPriceSol;
        const profitPercent = ((currentPriceSol - entryPriceSol) / entryPriceSol) * 100;

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
                  Math.min(
                      baseTrailingDistancePercent,
                      this.minTrailingDistanceBeforePartialPercent,
                  ),
              );
        const runnerTrailingMultiplier = trade.partialTakeProfitAt
            ? Math.max(1, this.getNumberConfig('RUNNER_TRAILING_DISTANCE_MULTIPLIER', 2))
            : 1;
        const effectiveTrailingDistancePercent =
            noiseAdjustedTrailingDistance * runnerTrailingMultiplier;

        this.logger.debug(
            `[Slot ${trade.slotNumber}] Evaluating ${trade.symbol}: Price: $${currentPrice.toFixed(8)} / ${currentPriceSol.toFixed(10)} SOL, Profit: ${profitPercent.toFixed(2)}%, SL: -${effectiveStopLossPercent}%, TSL: ${trailingStopPriceSol.toFixed(10)} SOL, basis=${priceBasis.basis}`,
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
                trailingStopPriceSol * currentSolUsd,
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
                const creatorDump = detectCreatorDump(
                    trade.initialCreatorBalance,
                    currentCreatorBalance,
                    this.devDumpThresholdRatio * 100,
                );
                if (creatorDump.detected) {
                    // A zero baseline means the creator had no tracked tokens; there is no dump to measure.
                    this.logger.warn(
                        `[Slot ${trade.slotNumber}] 🔥 EMERGENCY: Developer is dumping! PANIC SELL.`,
                    );
                    await this.tradeService.executeSell(trade.id, currentPrice, 'DEV_DUMP');
                    return;
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

        // FIX C1: the dynamic hold zone can be disabled outright via config, and is capped so a
        // trade can't sit in the -halfSL..-SL band indefinitely just because the AI keeps
        // reporting non-critical.
        if (
            this.enableDynamicHoldZone &&
            this.isDynamicHoldZone(profitPercent, effectiveStopLossPercent)
        ) {
            const zoneEnteredAt = this.dynamicHoldZoneEnteredAt.get(trade.id);
            const nowMs = Date.now();

            if (zoneEnteredAt === undefined) {
                this.dynamicHoldZoneEnteredAt.set(trade.id, nowMs);
                // FIX C3: zone-entry observability, so incident diagnosis doesn't need a DB query.
                this.logger.log(
                    `[Slot ${trade.slotNumber}] Dynamic hold zone ENTERED. tradeId=${trade.id} pnl=${profitPercent.toFixed(2)}% age=${(this.getTradeAgeMs(trade) / 1000).toFixed(1)}s`,
                );
            } else {
                const zoneDurationMs = nowMs - zoneEnteredAt;
                // Verifier MINOR fix: the zone timer is keyed off zoneEnteredAt, independent of
                // overall trade age. Without also requiring the overall min-hold window to have
                // elapsed, this is a second, shorter, unconditional bypass of the same FIX C2
                // guard (a trade can enter the zone almost immediately after open, then force-exit
                // here well before MIN_NON_CRITICAL_HOLD_SECONDS would have released it).
                const minHoldElapsed =
                    !this.conservativeExitGuardEnabled ||
                    this.minNonCriticalHoldMs <= 0 ||
                    this.getTradeAgeMs(trade, nowMs) >= this.minNonCriticalHoldMs;
                if (
                    this.dynamicHoldZoneMaxMs > 0 &&
                    zoneDurationMs >= this.dynamicHoldZoneMaxMs &&
                    minHoldElapsed
                ) {
                    this.logger.warn(
                        `[Slot ${trade.slotNumber}] Dynamic hold zone MAX DURATION exceeded (${(zoneDurationMs / 1000).toFixed(1)}s >= ${(this.dynamicHoldZoneMaxMs / 1000).toFixed(0)}s). Forcing exit regardless of AI health. pnl=${profitPercent.toFixed(2)}% sl=${effectiveStopLossPercent}%`,
                    );
                    this.dynamicHoldZoneEnteredAt.delete(trade.id);
                    // Verifier MINOR fix: distinct exitReason from the genuine hard-floor STOP_LOSS
                    // exit below, so the two are no longer indistinguishable in DB/reporting.
                    await this.tradeService.executeSell(
                        trade.id,
                        currentPrice,
                        'STOP_LOSS_ZONE_TIMEOUT',
                    );
                    return;
                }
            }

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
                this.dynamicHoldZoneEnteredAt.delete(trade.id);
                await this.tradeService.executeSell(trade.id, currentPrice, 'AI_HEALTH_CRITICAL');
                return;
            }

            this.logger.log(
                `[Slot ${trade.slotNumber}] AI Health HOLD. pnl=${profitPercent.toFixed(2)}% sl=${effectiveStopLossPercent}% reentry=${healthCheck.reentrySignal}. reason=${healthCheck.reasoning}`,
            );
            return;
        }

        // Not (or no longer) in the dynamic hold zone — release any tracked entry timestamp.
        if (this.dynamicHoldZoneEnteredAt.has(trade.id)) {
            this.dynamicHoldZoneEnteredAt.delete(trade.id);
        }

        // Route-aware stop loss remains the hard floor after the dynamic hold zone is exhausted.
        if (profitPercent <= -effectiveStopLossPercent) {
            // Record the moment the hard STOP_LOSS floor was FIRST detected — independent of
            // whether a guard below (dynamic hold zone / early-exit guard) subsequently holds
            // the position and delays the actual sell. "Triggered" means detected, not executed.
            // Fire-and-forget + atomic `slTriggeredAt: null` guard so this never blocks the hot
            // evaluation path and never overwrites an already-set timestamp on later ticks.
            if (!trade.slTriggeredAt) {
                // FIX C3: log the hard-floor crossing with trade age, so incident diagnosis doesn't
                // need a DB query. Verifier MINOR fix: gated on the same first-occurrence check as
                // the persistence below (slTriggeredAt still null) — without this it re-fired every
                // 2s tick for up to the whole min-hold window while a guard below held the position.
                this.logger.warn(
                    `[Slot ${trade.slotNumber}] STOP_LOSS floor crossed. tradeId=${trade.id} pnl=${profitPercent.toFixed(2)}% sl=${effectiveStopLossPercent}% age=${(this.getTradeAgeMs(trade) / 1000).toFixed(1)}s`,
                );
                void this.prismaService.trade
                    .updateMany({
                        where: { id: trade.id, slTriggeredAt: null },
                        data: {
                            slTriggeredAt: new Date(),
                            exitTriggerPriceSol: currentPrice,
                            exitTriggerPriceUsd: currentPrice * currentSolUsd,
                            exitTriggerPnlPercent: profitPercent,
                        },
                    })
                    .catch((err) => {
                        this.logger.warn(
                            `[Slot ${trade.slotNumber}] Failed to persist slTriggeredAt for tradeId=${trade.id}: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    });
            }

            if (
                await this.handleAiCutlossDefense(
                    trade,
                    currentPrice,
                    currentSolUsd,
                    profitPercent,
                    effectiveStopLossPercent,
                    normalizedFreshMarketSignals,
                )
            ) {
                return;
            }
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
        if (currentPriceSol > highestPriceSol && profitPercent >= trailingActivationPercent) {
            const calculatedStop = currentPriceSol * (1 - effectiveTrailingDistancePercent / 100);

            // Jarak trailing stop murni dari peak tanpa floor buatan di awal
            let newTrailingStop = calculatedStop;

            // 🛡️ BREAK-EVEN PROTECTION: lock a floor that actually covers round-trip fees,
            // not a cosmetic +2%. Uses the fee-aware estimate when available, else config.
            if (profitPercent >= 15) {
                const feeDragPercent = this.estimateFeeDragPercent(trade);
                const marginPercent = this.getNumberConfig('BREAKEVEN_MARGIN_PERCENT', 2);
                const configFloorPercent = this.getNumberConfig(
                    'RUNNER_BREAKEVEN_FLOOR_PERCENT',
                    8,
                );
                const floorPercent = Math.max(feeDragPercent + marginPercent, configFloorPercent);
                const breakEvenPlus = entryPriceSol * (1 + floorPercent / 100);
                newTrailingStop = Math.max(newTrailingStop, breakEvenPlus);
            }

            await this.prismaService.trade.update({
                where: { id: trade.id },
                data: { highestPrice: currentPriceSol, trailingStopPrice: newTrailingStop },
            });
            this.logger.debug(
                `[Slot ${trade.slotNumber}] New Peak SOL: ${currentPriceSol.toFixed(10)}. TSL Locked at: ${newTrailingStop.toFixed(10)} SOL`,
            );

            // Anti-Spam Trailing Alert
            const now = Date.now();
            const lastAlert = this.lastAlertTime.get(trade.id) || 0;
            if (profitPercent >= trailingActivationPercent && now - lastAlert > 5 * 60 * 1000) {
                await this.reportingService.sendTrailingAlert(
                    trade.tokenMint,
                    newTrailingStop * currentSolUsd,
                    currentPrice,
                    trade.symbol || undefined,
                );
                this.lastAlertTime.set(trade.id, now);
            }
        } else if (
            effectiveTrailingDistancePercent < baseTrailingDistancePercent &&
            trailingStopPriceSol > 0
        ) {
            const referencePrice = Math.max(highestPriceSol, currentPriceSol);
            const tightenedTrailingStop =
                referencePrice * (1 - effectiveTrailingDistancePercent / 100);

            if (tightenedTrailingStop > trailingStopPriceSol) {
                await this.prismaService.trade.update({
                    where: { id: trade.id },
                    data: { trailingStopPrice: tightenedTrailingStop },
                });
                this.logger.warn(
                    `[AI Brain] Tightening trailing stop realtime for ${trade.tokenMint}. Reference=${referencePrice.toFixed(10)} SOL NewTSL=${tightenedTrailingStop.toFixed(10)} SOL.`,
                );
                await this.sendRiskAdjustmentAlertIfNeeded(
                    trade,
                    referencePrice * currentSolUsd,
                    normalizedFreshMarketSignals,
                    baseTrailingDistancePercent,
                    effectiveTrailingDistancePercent,
                    tightenedTrailingStop * currentSolUsd,
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
        const effectiveHighestPrice = Math.max(highestPriceSol, currentPriceSol);
        if (profitPercent >= baseTP && effectiveHighestPrice > entryPriceSol * 1.35) {
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
            await this.persistExitTrigger(
                trade.id,
                currentPriceSol,
                currentSolUsd,
                profitPercent,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, 'PARTIAL_TAKE_PROFIT', 0.5);
            return;
        }

        // Trailing Stop Trigger
        if (trailingStopPriceSol > 0 && currentPriceSol <= trailingStopPriceSol) {
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
                `[Slot ${trade.slotNumber}] ${reason} at ${currentPriceSol.toFixed(10)} SOL / ${currentPrice.toFixed(8)} (Profit: ${profitPercent.toFixed(2)}%)`,
            );
            await this.persistExitTrigger(
                trade.id,
                currentPriceSol,
                currentSolUsd,
                profitPercent,
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
            const response = await DexLimiter.get<{ pairs: DexScreenerPair[] }>(url, {
                httpsAgent: this.getHttpsAgent(),
                timeout: 5000,
            });

            const pair = selectBestDexScreenerPair(response.data.pairs, tokenMint);
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
            const lastAlertAt = this.lastRiskAdjustmentAlertTime.get(trade.id) || 0;
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
            this.lastRiskAdjustmentAlertTime.set(trade.id, now);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `[AI Brain] Failed to send risk adjustment alert for ${trade.tokenMint}: ${message}`,
            );
        }
    }
}
