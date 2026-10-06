import { Zone, ZoneStrength } from './shved-zones';

export interface PlanTarget {
    low: number;
    high: number;
    strength: ZoneStrength;
    hits: number;
    /** Conservative: entry at the top of the band, exit at the bottom of the target. */
    gainPct: number;
    /** Optimistic: entry at the bottom of the band, exit at the top of the target. */
    bestGainPct: number;
}

export interface TradePlan {
    entryLow: number;
    entryHigh: number;
    entryStrength: ZoneStrength;
    entryHits: number;
    /** Signed distance from current price to the top of the entry band; negative means below. */
    distancePct: number;
    /** Price is sitting inside this entry band right now. */
    active: boolean;
    targets: PlanTarget[];
}

export interface TradePlanOptions {
    /**
     * Smallest gain worth listing, in percent.
     *
     * A round trip costs roughly 0.0011 SOL in fees before any slippage, which on a $20 position is
     * about 0.7%. A plan promising less than a couple of percent is a plan to pay fees, so it is
     * left out rather than shown and silently relied on.
     */
    minGainPct: number;
    /** Targets listed per entry: the nearest one, and a stretch. More is noise, not information. */
    maxTargetsPerEntry: number;
    maxPlans: number;
}

export const DEFAULT_PLAN_OPTIONS: TradePlanOptions = {
    minGainPct: 2,
    maxTargetsPerEntry: 2,
    maxPlans: 4,
};

/**
 * Every buy band paired with the sell bands above it.
 *
 * The chart already finds more than one zone on each side; showing only the nearest pair throws away
 * the rest of the map. A trader planning an entry wants to know what is underneath if this level
 * fails, and what is overhead if it holds — and both questions are answered by zones that were
 * computed anyway.
 *
 * Every number here is derived from band edges, never from a projection. `gainPct` measures from the
 * top of the entry band to the bottom of the target, which is the worst version of the trade that
 * still counts as working: buying at the least favourable price in the zone and selling at the first
 * price where supply appeared. The optimistic figure travels beside it rather than instead of it.
 */
export function buildTradePlans(
    zones: ReadonlyArray<Zone>,
    price: number,
    options: Partial<TradePlanOptions> = {},
): TradePlan[] {
    const opts = { ...DEFAULT_PLAN_OPTIONS, ...options };
    if (!Number.isFinite(price) || price <= 0) return [];

    const supports = zones
        .filter((z) => z.type === 'SUPPORT' && z.low > 0 && z.high > z.low)
        .sort((a, b) => b.high - a.high);
    const resistances = zones
        .filter((z) => z.type === 'RESISTANCE' && z.low > 0 && z.high > z.low)
        .sort((a, b) => a.low - b.low);

    const plans: TradePlan[] = [];

    for (const entry of supports) {
        // Only bands above the entry can be a target. A "target" below the entry is a loss with a
        // confident label on it.
        const above = resistances.filter((r) => r.low > entry.high);

        const targets: PlanTarget[] = [];
        for (const target of above) {
            const gainPct = ((target.low - entry.high) / entry.high) * 100;
            if (gainPct < opts.minGainPct) continue;
            targets.push({
                low: target.low,
                high: target.high,
                strength: target.strength,
                hits: target.hits,
                gainPct,
                bestGainPct: ((target.high - entry.low) / entry.low) * 100,
            });
            if (targets.length >= opts.maxTargetsPerEntry) break;
        }

        if (targets.length === 0) continue;

        plans.push({
            entryLow: entry.low,
            entryHigh: entry.high,
            entryStrength: entry.strength,
            entryHits: entry.hits,
            distancePct: ((entry.high - price) / price) * 100,
            active: price >= entry.low && price <= entry.high,
            targets,
        });
    }

    // Nearest entry first, because that is the one a reader can act on today. An entry 40% below
    // price with a glorious target is a bookmark, not a plan, and sorting by payoff would put it on
    // top of the one that matters.
    plans.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
    return plans.slice(0, opts.maxPlans);
}
