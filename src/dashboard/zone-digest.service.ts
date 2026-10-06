import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CandleService } from './candle.service';
import { busiestFromFeed, lookupPairs } from './pair-lookup';
import { Zone, computeShvedZones, minimumCandles, resolveNearestZones } from './shved-zones';
import { ZoneAction, adviseOnZones } from './zone-advice';

export interface ZoneDigestEntry {
    mint: string;
    symbol: string;
    price: number;
    candleCount: number;
    ageHours?: number;
    liquidityUsd?: number;
    source: 'bot' | 'feed';
    buyZone?: Zone;
    sellZone?: Zone;
    /** Set when price sits inside a band right now, which is neither a target nor a warning. */
    insideZone?: Zone;
    /** Signed: negative means price sits above the buy band, which is where you want to be. */
    buyDistancePct?: number;
    sellDistancePct?: number;
    /** Upside to the sell band over downside to the buy band. Undefined when either side is absent. */
    rewardRisk?: number;
    /** The same one-word verdict the web page shows, from the same function. */
    action: ZoneAction;
}

export interface ZoneDigest {
    entries: ZoneDigestEntry[];
    scanned: number;
    skipped: Array<{ symbol: string; why: string }>;
}

/**
 * Ranks coins by how close price sits to a demand band with supply above it.
 *
 * Used by the Telegram report. The web page does its own per-coin fetches because it is driven by
 * whatever the viewer clicks, but both read through `CandleService`, so both see the same cache and
 * the same pool for a given mint.
 *
 * Deliberately small: GeckoTerminal is a serial lane at 2.5 s per call, so a digest over many coins
 * would take minutes. Six is roughly fifteen seconds, which a cron can absorb without the report
 * ever being the reason a candle fetch is late.
 */
@Injectable()
export class ZoneDigestService {
    private readonly logger = new Logger(ZoneDigestService.name);

    /** Hardcoded rather than a knob: it is a rate-limit consequence, not a preference. */
    private static readonly MAX_COINS = 6;

    constructor(
        private readonly configService: ConfigService,
        private readonly candleService: CandleService,
        private readonly prismaService: PrismaService,
    ) {}

    private get minLiquidityUsd(): number {
        const raw = Number.parseFloat(
            this.configService.get<string>('DASHBOARD_MIN_LIQUIDITY_USD', '25000'),
        );
        return Number.isFinite(raw) ? raw : 25_000;
    }

    private num(key: string, fallback: number): number {
        const raw = Number.parseFloat(this.configService.get<string>(key, String(fallback)));
        return Number.isFinite(raw) ? raw : fallback;
    }

    async build(): Promise<ZoneDigest> {
        const candidates = await this.candidates();
        const entries: ZoneDigestEntry[] = [];
        const skipped: Array<{ symbol: string; why: string }> = [];

        for (const c of candidates) {
            const result = await this.candleService.getCandles(c.mint);
            if (result.problem) {
                skipped.push({ symbol: c.symbol, why: result.problem });
                continue;
            }

            const zones = computeShvedZones(result.candles, {
                fuzzFactor: this.num('SHVED_FUZZ_FACTOR', 0.75),
                fastFactor: this.num('SHVED_FAST_FACTOR', 3),
                slowFactor: this.num('SHVED_SLOW_FACTOR', 6),
            });
            if (zones.length === 0) {
                skipped.push({ symbol: c.symbol, why: 'no_zones' });
                continue;
            }

            const price = result.candles[result.candles.length - 1].close;
            const { support, resistance, inside } = resolveNearestZones(zones, price);

            // The same verdict the web page shows, from the same function. Computing it twice is how
            // two surfaces end up disagreeing about one chart, and the one a reader happens to open
            // first becomes the one they believe.
            const advice = adviseOnZones({
                price,
                buyZone: support,
                sellZone: resistance,
                insideZone: inside,
                candleCount: result.candles.length,
                minimumCandles: minimumCandles(),
            });
            const { buyDistancePct, sellDistancePct, rewardRisk } = advice;

            entries.push({
                mint: c.mint,
                symbol: c.symbol,
                price,
                candleCount: result.candles.length,
                ageHours: result.ageHours,
                liquidityUsd: result.liquidityUsd,
                source: c.source,
                buyZone: support,
                sellZone: resistance,
                insideZone: inside,
                buyDistancePct,
                sellDistancePct,
                rewardRisk,
                action: advice.action,
            });
        }

        // Entries with both sides first, best reward-to-risk at the top. A coin whose zones only
        // exist on one side is still listed, but below everything that can actually be planned.
        entries.sort((a, b) => (b.rewardRisk ?? -1) - (a.rewardRisk ?? -1));

        return { entries, scanned: candidates.length, skipped };
    }

    /** Bot candidates first, then the busiest boosted tokens, capped by the rate-limit budget. */
    private async candidates(): Promise<
        Array<{ mint: string; symbol: string; source: 'bot' | 'feed' }>
    > {
        const out: Array<{ mint: string; symbol: string; source: 'bot' | 'feed' }> = [];
        const seen = new Set<string>();

        try {
            const watchlist = await this.prismaService.watchlist.findMany({
                where: { status: 'PENDING' },
                orderBy: { lastCheckedAt: 'desc' },
                take: ZoneDigestService.MAX_COINS,
                select: { tokenMint: true },
            });
            const mints = watchlist.map((w) => w.tokenMint);
            if (mints.length > 0) {
                for (const p of await lookupPairs(mints)) {
                    const mint = p.baseToken?.address;
                    if (!mint || seen.has(mint)) continue;
                    // A token with no depth cannot be entered at the band price, so a zone drawn on
                    // it is decoration. Same floor the feed side uses.
                    if ((p.liquidity?.usd || 0) < this.minLiquidityUsd) continue;
                    seen.add(mint);
                    out.push({ mint, symbol: p.baseToken?.symbol || '?', source: 'bot' });
                }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[ZoneDigest] Watchlist read failed: ${msg}.`);
        }

        try {
            const feed = await busiestFromFeed(this.minLiquidityUsd, ZoneDigestService.MAX_COINS);
            for (const p of feed) {
                const mint = p.baseToken?.address;
                if (!mint || seen.has(mint)) continue;
                seen.add(mint);
                out.push({ mint, symbol: p.baseToken?.symbol || '?', source: 'feed' });
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[ZoneDigest] Feed read failed: ${msg}.`);
        }

        return out.slice(0, ZoneDigestService.MAX_COINS);
    }
}
