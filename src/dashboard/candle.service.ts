import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DexLimiter } from '../common/dex-limiter';
import { GeckoLimiter } from '../common/gecko-limiter';
import { DexScreenerPair } from '../dto/analyzer.dto';
import { Candle } from './shved-zones';

export interface CandleResult {
    candles: Candle[];
    poolAddress?: string;
    /** Spot price from DexScreener, kept separate so the two sources can be cross-checked. */
    dexPriceUsd?: number;
    symbol?: string;
    ageHours?: number;
    liquidityUsd?: number;
    /** Token logo, carried through so the chart header can show it without a second lookup. */
    imageUrl?: string;
    /** The timeframe actually used, which may differ from the one asked for. */
    timeframeMinutes?: number;
    /** Set when the series was rejected, so callers can say why instead of showing an empty chart. */
    problem?: 'no_pool' | 'no_candles' | 'scale_mismatch' | 'rate_limited';
}

interface CacheEntry {
    value: CandleResult;
    expiresAt: number;
}

/**
 * Candle history for a mint, which this bot has never had before.
 *
 * Every other price read in the app is a spot snapshot; nothing stores or fetches a series. The
 * zones need real bars, and GeckoTerminal is the only source reachable here — Binance and Kraken
 * are DNS-hijacked to an ISP block page on this network, which surfaces as a certificate error for
 * `internetsehatku.com` rather than as an honest refusal.
 */
@Injectable()
export class CandleService {
    private readonly logger = new Logger(CandleService.name);
    private readonly cache = new Map<string, CacheEntry>();

    constructor(private readonly configService: ConfigService) {}

    private num(key: string, fallback: number): number {
        const raw = Number.parseFloat(this.configService.get<string>(key, String(fallback)));
        return Number.isFinite(raw) ? raw : fallback;
    }

    private get aggregateMinutes(): number {
        return Math.max(1, this.num('DASHBOARD_CANDLE_TF', 5));
    }

    /**
     * The timeframes GeckoTerminal actually serves, in minutes.
     *
     * Not a free-form number: the API takes a bucket (`minute`, `hour`, `day`) plus an `aggregate`
     * it accepts only from a fixed list, so 10m and 30m do not exist upstream and asking for them
     * returns an error rather than a close approximation. A request for anything else snaps to the
     * nearest supported value, because a chart drawn at a timeframe the caller did not choose is
     * still better than an empty one, as long as the answer says which timeframe it used.
     */
    static readonly TIMEFRAMES: ReadonlyArray<{ minutes: number; path: string; aggregate: number }> =
        [
            { minutes: 1, path: 'minute', aggregate: 1 },
            { minutes: 5, path: 'minute', aggregate: 5 },
            { minutes: 15, path: 'minute', aggregate: 15 },
            { minutes: 60, path: 'hour', aggregate: 1 },
            { minutes: 240, path: 'hour', aggregate: 4 },
            { minutes: 720, path: 'hour', aggregate: 12 },
            { minutes: 1440, path: 'day', aggregate: 1 },
        ];

    private resolveTimeframe(requested?: number) {
        const wanted = Number.isFinite(requested) && (requested as number) > 0
            ? (requested as number)
            : this.aggregateMinutes;
        return CandleService.TIMEFRAMES.reduce((best, tf) =>
            Math.abs(tf.minutes - wanted) < Math.abs(best.minutes - wanted) ? tf : best,
        );
    }

    private get candleLimit(): number {
        return Math.max(50, Math.min(1000, this.num('DASHBOARD_CANDLE_LIMIT', 300)));
    }

    private get cacheTtlMs(): number {
        return Math.max(10_000, this.num('DASHBOARD_CACHE_TTL_MS', 300_000));
    }

    /**
     * Candles for a mint, cached per (mint, timeframe).
     *
     * The cache is what makes a refreshable page safe against a 30-requests-per-minute budget: a
     * dashboard that redraws every few seconds must not translate into a fetch every few seconds.
     */
    async getCandles(mint: string, timeframeMinutes?: number): Promise<CandleResult> {
        const tf = this.resolveTimeframe(timeframeMinutes);
        const key = `${mint}:${tf.minutes}:${this.candleLimit}`;
        const cached = this.cache.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.value;

        const result = await this.load(mint, tf);

        // A rate-limited or empty answer must not evict a good series that is merely stale — a
        // slightly old chart is far more useful than a blank one.
        if (result.problem && cached) return cached.value;

        this.cache.set(key, { value: result, expiresAt: Date.now() + this.cacheTtlMs });
        this.prune();
        return result;
    }

    private prune(): void {
        const now = Date.now();
        for (const [k, v] of this.cache.entries()) {
            if (v.expiresAt <= now) this.cache.delete(k);
        }
    }

    private async load(
        mint: string,
        tf: { minutes: number; path: string; aggregate: number },
    ): Promise<CandleResult> {
        const pair = await this.resolveDeepestPair(mint);
        if (!pair?.pairAddress) return { candles: [], problem: 'no_pool', timeframeMinutes: tf.minutes };

        const dexPriceUsd = Number.parseFloat(pair.priceUsd || '0') || undefined;
        const meta: CandleResult = {
            candles: [],
            poolAddress: pair.pairAddress,
            dexPriceUsd,
            symbol: pair.baseToken?.symbol,
            ageHours: pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : undefined,
            liquidityUsd: pair.liquidity?.usd,
            imageUrl: pair.info?.imageUrl,
            timeframeMinutes: tf.minutes,
        };

        let rows: number[][] = [];
        try {
            // `token=<mint>` is mandatory, not a nicety. Without it GeckoTerminal prices whichever
            // side it treats as the pool's base, and for a TOKEN/TOKEN pool that is the wrong one:
            // a USEFUL/USELESS pool returned USELESS at $0.23 while USEFUL traded at $0.000126 —
            // a 1,800x error that still produced perfectly plausible-looking zones.
            const url =
                `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pair.pairAddress}` +
                `/ohlcv/${tf.path}?aggregate=${tf.aggregate}&limit=${this.candleLimit}` +
                `&currency=usd&token=${mint}`;
            const response = await GeckoLimiter.get<{
                data?: { attributes?: { ohlcv_list?: number[][] } };
            }>(url);
            rows = response.data?.data?.attributes?.ohlcv_list ?? [];
        } catch (error) {
            const status = (error as { response?: { status?: number } })?.response?.status;
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[Candles] ${mint} failed: ${msg}.`);
            return { ...meta, problem: status === 429 ? 'rate_limited' : 'no_candles' };
        }

        const candles = rows
            .map(([at, open, high, low, close, volume]) => ({ at, open, high, low, close, volume }))
            .filter((c) => Number.isFinite(c.close) && c.close > 0 && Number.isFinite(c.at))
            // GeckoTerminal answers newest-first; the algorithm expects chronological order.
            .sort((a, b) => a.at - b.at);

        if (candles.length === 0) return { ...meta, problem: 'no_candles' };

        // Cross-check the two sources before trusting either. A wide divergence means the series is
        // describing a different asset than the price, and zones built from it would be fiction
        // dressed as analysis.
        const lastClose = candles[candles.length - 1].close;
        if (dexPriceUsd && dexPriceUsd > 0) {
            const ratio = lastClose / dexPriceUsd;
            if (ratio > 5 || ratio < 0.2) {
                this.logger.warn(
                    `[Candles] ${mint} scale mismatch: candle=${lastClose} dex=${dexPriceUsd} (${ratio.toFixed(1)}x).`,
                );
                return { ...meta, problem: 'scale_mismatch' };
            }
        }

        return { ...meta, candles };
    }

    /** The deepest Solana pair for a mint — the same choice `selectBestDexScreenerPair` makes. */
    private async resolveDeepestPair(mint: string): Promise<DexScreenerPair | undefined> {
        try {
            const response = await DexLimiter.get<{ pairs?: DexScreenerPair[] }>(
                `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
                { timeout: 8000 },
            );
            return (response.data?.pairs ?? [])
                .filter(
                    (p) =>
                        p.chainId === 'solana' &&
                        p.baseToken?.address?.toLowerCase() === mint.toLowerCase(),
                )
                .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[Candles] Pair lookup failed for ${mint}: ${msg}.`);
            return undefined;
        }
    }
}
