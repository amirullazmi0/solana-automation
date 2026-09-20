import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { computeNetProfitUsd } from '../common/fee-utils';
import { PrismaService } from '../prisma/prisma.service';
import { MetaLabelService } from './meta-label.service';
import { MetaSocialSource } from './meta-social';
import { HeatOptions, MetaAggregate, MetaHeat, computeHeat } from './meta-trend';

interface PendingSighting {
    label: string;
    tokenMint: string;
    volume5m: number | null;
    liquidityUsd: number | null;
    isBoosted: boolean;
    seenAt: Date;
}

/**
 * Turns a stream of token sightings and a ledger of closed trades into one number per meta.
 *
 * Everything here is shaped by call frequency. `recordSighting` is reached from the analyzer, which
 * re-examines the same mint about once a second for up to twelve minutes, so a naive implementation
 * would write several hundred rows for one token and report it as the busiest theme on the chain.
 * Sightings are therefore deduplicated per mint over a window and written in batches, which also
 * makes the stored count mean something real: the same mint seen across three separate windows is
 * three pieces of evidence, while the same mint seen three hundred times in one window is one.
 *
 * Reads go the other way. `getHeat` is consulted inside the gate chain for every candidate, so it
 * can never touch the database -- the aggregates are recomputed on a timer and served from memory.
 */
@Injectable()
export class MetaTrendService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(MetaTrendService.name);

    private heat = new Map<string, MetaHeat>();
    private previousRanking = new Map<string, number>();
    private lastRefreshAt = 0;

    private readonly lastSighting = new Map<string, number>();
    private pending: PendingSighting[] = [];

    /**
     * Mints that arrived via the DexScreener boosts/profiles feed, i.e. someone paid to promote
     * them.
     *
     * Lives here rather than on the scanner because the two halves of this fact are produced and
     * consumed in modules that cannot import each other: the scanner learns a mint was boosted at
     * discovery, while only the analyzer later learns its name and can attribute it to a meta.
     * This module is global and sits below both, so it is the one place both can reach.
     */
    private readonly boostedMints = new Map<string, number>();

    private refreshTimer?: NodeJS.Timeout;
    private writeTimer?: NodeJS.Timeout;

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly metaLabelService: MetaLabelService,
        private readonly socialSource: MetaSocialSource,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.refresh().catch(() => undefined);

        this.refreshTimer = setInterval(() => {
            void this.refresh().catch(() => undefined);
        }, this.refreshMs);
        this.refreshTimer.unref?.();

        // Sightings drain on their own, faster timer: holding them until the next aggregate refresh
        // would lose up to two minutes of evidence on every restart.
        this.writeTimer = setInterval(() => {
            void this.drainSightings().catch(() => undefined);
        }, 15000);
        this.writeTimer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        if (this.writeTimer) clearInterval(this.writeTimer);
    }

    private get windowHours(): number {
        return this.readNumber('META_WINDOW_HOURS', 12, 1, 168);
    }

    private get refreshMs(): number {
        return this.readNumber('META_REFRESH_MS', 120000, 10000, 3600000);
    }

    /**
     * Length of the "now" slice the acceleration term compares against the rest of the window.
     *
     * An hour by default: long enough that a handful of launches is not noise, short enough that a
     * meta waking up is visible while it is still waking up rather than after it has peaked.
     */
    private get accelWindowMinutes(): number {
        return this.readNumber('META_ACCEL_WINDOW_MIN', 60, 5, 1440);
    }

    private get sightingDedupeMs(): number {
        return this.readNumber('META_SIGHTING_DEDUPE_MS', 300000, 10000, 3600000);
    }

    private get heatOptions(): Partial<HeatOptions> {
        return {
            weightSightings: this.readNumber('META_WEIGHT_SIGHTINGS', 0.3, 0, 10),
            weightVolume: this.readNumber('META_WEIGHT_VOLUME', 0.4, 0, 10),
            weightBoost: this.readNumber('META_WEIGHT_BOOST', 0.2, 0, 10),
            weightSocial: this.readNumber('META_WEIGHT_SOCIAL', 0.1, 0, 10),
            weightAccel: this.readNumber('META_WEIGHT_ACCEL', 0.25, 0, 10),
            pnlWeight: this.readNumber('META_PNL_WEIGHT', 0.6, 0, 1),
            minTradeSample: this.readNumber('META_MIN_TRADE_SAMPLE', 8, 1, 1000),
            hotPercentile: this.readNumber('META_HOT_PERCENTILE', 70, 0, 100),
            coldPercentile: this.readNumber('META_COLD_PERCENTILE', 30, 0, 100),
        };
    }

    private readNumber(key: string, fallback: number, min: number, max: number): number {
        const raw = Number.parseFloat(this.configService.get<string>(key, String(fallback)));
        if (!Number.isFinite(raw)) return fallback;
        return Math.max(min, Math.min(max, raw));
    }

    /** Records that a mint came from the paid-promotion feed. Called by the scanner at discovery. */
    markBoosted(tokenMint: string): void {
        const mint = String(tokenMint ?? '').trim();
        if (!mint) return;

        const now = Date.now();
        this.boostedMints.set(mint, now);

        if (this.boostedMints.size > 5000) {
            const cutoff = now - 6 * 60 * 60 * 1000;
            for (const [key, at] of this.boostedMints.entries()) {
                if (at < cutoff) this.boostedMints.delete(key);
            }
        }
    }

    /** Whether this mint was promoted, within the same 6-hour horizon the scanner dedupes on. */
    isBoosted(tokenMint: string): boolean {
        const at = this.boostedMints.get(tokenMint);
        if (at === undefined) return false;
        return Date.now() - at < 6 * 60 * 60 * 1000;
    }

    /**
     * Synchronous heat read for one label. Undefined until the first refresh has produced numbers,
     * or when the label has no evidence in the window at all.
     */
    getHeat(label: string | undefined): MetaHeat | undefined {
        if (!label) return undefined;
        return this.heat.get(label);
    }

    /** Heat for a mint, resolving its label first. The form the gate chain actually wants. */
    getHeatForMint(tokenMint: string): MetaHeat | undefined {
        return this.getHeat(this.metaLabelService.getLabel(tokenMint));
    }

    /** Whole leaderboard, hottest first. Used by the report and the Telegram command. */
    getLeaderboard(): MetaHeat[] {
        return [...this.heat.values()].sort((a, b) => b.heatScore - a.heatScore);
    }

    /** Rank change since the previous refresh, so the report can show what is rising. */
    getRankDelta(label: string): number | undefined {
        const previous = this.previousRanking.get(label);
        if (previous === undefined) return undefined;
        const current = this.getLeaderboard().findIndex((entry) => entry.label === label);
        if (current < 0) return undefined;
        return previous - current;
    }

    getLastRefreshAt(): number {
        return this.lastRefreshAt;
    }

    /**
     * Records that a token of some meta was seen trading.
     *
     * Silently does nothing when the mint has no label yet. That is not a lost data point: the
     * analyzer calls this again on its next pass, by which time the batch labeller has usually
     * answered, so the sighting lands a few seconds later instead of never.
     */
    recordSighting(input: {
        tokenMint: string;
        volume5m?: number;
        liquidityUsd?: number;
        isBoosted?: boolean;
    }): void {
        const tokenMint = String(input.tokenMint ?? '').trim();
        if (!tokenMint) return;

        const label = this.metaLabelService.getLabel(tokenMint);
        if (!label) return;

        const now = Date.now();
        const last = this.lastSighting.get(tokenMint) ?? 0;
        if (now - last < this.sightingDedupeMs) return;
        this.lastSighting.set(tokenMint, now);

        this.pending.push({
            label,
            tokenMint,
            volume5m: Number.isFinite(input.volume5m) ? Number(input.volume5m) : null,
            liquidityUsd: Number.isFinite(input.liquidityUsd) ? Number(input.liquidityUsd) : null,
            isBoosted: input.isBoosted === true,
            seenAt: new Date(now),
        });

        // Bound the dedupe map the same way the analyzer bounds its own recent-name cache: by age
        // first so a quiet period cannot pin stale mints, then by size as a hard stop.
        if (this.lastSighting.size > 5000) {
            const cutoff = now - this.sightingDedupeMs;
            for (const [mint, at] of this.lastSighting.entries()) {
                if (at < cutoff) this.lastSighting.delete(mint);
            }
        }
    }

    private async drainSightings(): Promise<void> {
        if (this.pending.length === 0) return;
        const batch = this.pending.splice(0, this.pending.length);
        try {
            await this.prismaService.metaSighting.createMany({ data: batch });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            // Dropped rather than retried: sightings are a sample, and a failed write costs a
            // little precision in the aggregate, never correctness of a trade decision.
            this.logger.warn(`[Meta] Sighting write of ${batch.length} failed: ${msg}.`);
        }
    }

    /**
     * Recomputes every label's heat from the four evidence sources, then swaps the cache.
     *
     * Built as a whole-map replacement rather than an in-place update because the score is
     * relative: a label's heat only means something against the same snapshot of its peers, and a
     * half-updated map would rank labels from two different windows against each other.
     */
    async refresh(): Promise<void> {
        try {
            const windowMinutes = this.windowHours * 60;
            const recentMinutes = Math.min(this.accelWindowMinutes, Math.max(windowMinutes - 1, 1));
            const since = new Date(Date.now() - windowMinutes * 60 * 1000);
            const recentSince = new Date(Date.now() - recentMinutes * 60 * 1000);

            const [activity, trades] = await Promise.all([
                this.loadActivity(since, recentSince),
                this.loadTradeOutcomes(since),
            ]);

            const labels = new Set<string>([...activity.keys(), ...trades.keys()]);
            if (labels.size === 0) {
                this.heat = new Map();
                this.lastRefreshAt = Date.now();
                return;
            }

            const social = await this.socialSource.getMentionVelocity([...labels]);

            const aggregates: MetaAggregate[] = [...labels].map((label) => {
                const a = activity.get(label);
                const t = trades.get(label);
                return {
                    label,
                    sightings: a?.sightings ?? 0,
                    volumeSum: a?.volumeSum ?? 0,
                    boostCount: a?.boostCount ?? 0,
                    recentSightings: a?.recent ?? 0,
                    windowMinutes,
                    recentMinutes,
                    trades: t?.trades ?? 0,
                    netPnlTotal: t?.netPnlTotal ?? 0,
                    wins: t?.wins ?? 0,
                    socialScore: social.get(label) ?? 0,
                };
            });

            // Snapshot the outgoing order before replacing it, so the report can say what moved.
            this.previousRanking = new Map(
                this.getLeaderboard().map((entry, index) => [entry.label, index]),
            );
            this.heat = computeHeat(aggregates, this.heatOptions);
            this.lastRefreshAt = Date.now();

            await this.pruneSightings(since);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            // The previous map stays in place. Serving slightly stale heat is strictly better than
            // serving none, which would silently remove the meta signal from every gate decision.
            this.logger.warn(`[Meta] Refresh failed, keeping previous heat: ${msg}.`);
        }
    }

    private async loadActivity(
        since: Date,
        recentSince: Date,
    ): Promise<
        Map<string, { sightings: number; volumeSum: number; boostCount: number; recent: number }>
    > {
        const rows = await this.prismaService.metaSighting.groupBy({
            by: ['label'],
            where: { seenAt: { gte: since } },
            _count: { _all: true },
            _sum: { volume5m: true },
        });

        // The same index, read twice over a narrower bound. This second pass is what turns the
        // sightings signal from a level into a rate of change -- the only term here that can lead
        // the meta rather than confirm it after the fact.
        const recent = await this.prismaService.metaSighting.groupBy({
            by: ['label'],
            where: { seenAt: { gte: recentSince } },
            _count: { _all: true },
        });
        const recentByLabel = new Map(recent.map((row) => [row.label, row._count._all]));

        // Prisma cannot express a filtered count inside groupBy, so boosts come from a second,
        // equally cheap pass over the same index rather than from raw SQL.
        const boosted = await this.prismaService.metaSighting.groupBy({
            by: ['label'],
            where: { seenAt: { gte: since }, isBoosted: true },
            _count: { _all: true },
        });
        const boostByLabel = new Map(boosted.map((row) => [row.label, row._count._all]));

        return new Map(
            rows.map((row) => [
                row.label,
                {
                    sightings: row._count._all,
                    volumeSum: Number(row._sum.volume5m ?? 0),
                    boostCount: boostByLabel.get(row.label) ?? 0,
                    recent: recentByLabel.get(row.label) ?? 0,
                },
            ]),
        );
    }

    /**
     * Realised outcomes per label.
     *
     * Net P&L is computed in JS through `computeNetProfitUsd` rather than in SQL: `profitUsd` is
     * stored gross and the fee conversion lives in that one helper, so duplicating the arithmetic
     * in a query would create a second definition of "net" that could drift from the one the daily
     * summary reports.
     */
    private async loadTradeOutcomes(
        since: Date,
    ): Promise<Map<string, { trades: number; netPnlTotal: number; wins: number }>> {
        const rows = await this.prismaService.trade.findMany({
            where: {
                status: 'CLOSED',
                mode: 'LIVE',
                metaLabel: { not: null },
                updatedAt: { gte: since },
            },
            select: {
                metaLabel: true,
                profitUsd: true,
                totalFeesSol: true,
                solPriceAtEntry: true,
            },
        });

        const out = new Map<string, { trades: number; netPnlTotal: number; wins: number }>();
        for (const row of rows) {
            const label = row.metaLabel;
            if (!label) continue;
            const net = computeNetProfitUsd(row);
            const entry = out.get(label) ?? { trades: 0, netPnlTotal: 0, wins: 0 };
            entry.trades += 1;
            entry.netPnlTotal += net;
            if (net > 0) entry.wins += 1;
            out.set(label, entry);
        }
        return out;
    }

    private async pruneSightings(since: Date): Promise<void> {
        try {
            await this.prismaService.metaSighting.deleteMany({ where: { seenAt: { lt: since } } });
        } catch {
            // Growth control only. A failed prune costs disk, never a wrong aggregate, because
            // every query is already bounded by the same window.
        }
    }
}
