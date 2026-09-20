/**
 * Scoring how alive a meta is, from four kinds of evidence that disagree with each other on purpose.
 *
 * Three of them measure *attention*: how many tokens of this theme the scanner saw, how much volume
 * they carried, and how many of them someone paid to promote. The fourth measures *money*: what our
 * own closed trades in that theme actually netted. Attention is available immediately and is a
 * leading signal; P&L is the only one that answers the question that matters, and arrives late.
 *
 * The blend between them is therefore not fixed. Below a minimum number of closed trades a label is
 * scored on attention alone, because a single lucky trade on a two-trade sample would otherwise
 * crown a meta. Above it, realised P&L takes the dominant weight -- a meta can be the busiest thing
 * on the chain and still be the fastest way to lose money, and when the two signals disagree it is
 * the P&L that has been paid for.
 */

export type MetaTier = 'HOT' | 'WARM' | 'COLD' | 'TOXIC';

/** Raw rolling counts for one label. Everything here is a plain sum over the window. */
export interface MetaAggregate {
    label: string;
    sightings: number;
    volumeSum: number;
    boostCount: number;
    /** Sightings inside the recent sub-window only, used to measure change rather than level. */
    recentSightings?: number;
    /** Length of the full window and of the recent slice, in minutes. */
    windowMinutes?: number;
    recentMinutes?: number;
    /** Closed LIVE trades bought under this label within the window. */
    trades: number;
    netPnlTotal: number;
    wins?: number;
    /** Mention velocity from an external social source; 0 when that source is disabled. */
    socialScore?: number;
}

export interface MetaHeat {
    label: string;
    heatScore: number;
    tier: MetaTier;
    sampleSize: number;
    netPnlPerTrade: number;
    winRate: number;
    activityScore: number;
    /** How much faster this meta is launching now than it was earlier in the window. */
    accelRatio: number;
    /** Undefined until the label has enough closed trades to be judged on money. */
    pnlScore?: number;
    reasons: string[];
}

export interface HeatOptions {
    weightSightings: number;
    weightVolume: number;
    weightBoost: number;
    weightSocial: number;
    weightAccel: number;
    /** Share of the final score taken by P&L once the sample is large enough. */
    pnlWeight: number;
    minTradeSample: number;
    hotPercentile: number;
    coldPercentile: number;
}

export const DEFAULT_HEAT_OPTIONS: HeatOptions = {
    // Rebalanced when acceleration was added: the level terms were each shaded down rather than
    // the new term simply piled on top, so the blend still sums to one and the tier percentiles
    // keep meaning what they did before.
    weightSightings: 0.2,
    weightVolume: 0.3,
    weightBoost: 0.15,
    weightSocial: 0.1,
    weightAccel: 0.25,
    pnlWeight: 0.6,
    minTradeSample: 8,
    hotPercentile: 70,
    coldPercentile: 30,
};

/**
 * Where `value` sits among `values`, as 0..100.
 *
 * Percentile rather than a normalised magnitude because the four inputs have no common unit -- USD
 * volume, a raw count and a dollars-per-trade average cannot be averaged directly, and whichever
 * had the largest numbers would otherwise dominate the blend regardless of its weight.
 *
 * When every label ties (including the one-label case) the answer is 50: no label stands out, so
 * none is ranked above another.
 */
export function percentileRank(values: ReadonlyArray<number>, value: number): number {
    const finite = values.filter((v) => Number.isFinite(v));
    if (finite.length === 0) return 50;

    const min = Math.min(...finite);
    const max = Math.max(...finite);
    if (max === min) return 50;

    const below = finite.filter((v) => v < value).length;
    const equal = finite.filter((v) => v === value).length;
    return ((below + equal / 2) / finite.length) * 100;
}

function clamp(value: number, low: number, high: number): number {
    if (!Number.isFinite(value)) return low;
    return Math.max(low, Math.min(high, value));
}

function safeDivide(numerator: number, denominator: number): number {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
    return numerator / denominator;
}

/**
 * How much faster this meta is producing tokens now than it was earlier in the window.
 *
 * This is the one term that leads rather than follows. A meta's *level* -- eight animal tokens in
 * the window -- says it already happened. Its *rate of change* says it is happening: developers
 * mass-launch copies of a theme before retail arrives, so the launch rate per theme is a live
 * census of what builders believe is about to run.
 *
 * Deliberately shaped like `volumeSurge` in the analyzer (recent rate over baseline rate), and
 * deliberately avoiding the trap that formula fell into there. That one divided by a fixed bucket
 * count regardless of how much history existed, so for a young token the numerator and denominator
 * cancelled and every token reported the same constant. The guard here is the baseline floor: a
 * label whose sightings are *all* inside the recent slice has no history to compare against, and
 * without a floor it would divide by zero and rank first forever on three sightings. Treating the
 * baseline as at least one sighting over the baseline period caps a brand-new label's ratio at
 * roughly its own recent count, so it can rise quickly but cannot beat physics.
 *
 * Returns 1.0 -- flat, no opinion -- whenever the arithmetic is not meaningful.
 */
export function computeAcceleration(input: {
    sightings: number;
    recentSightings: number;
    windowMinutes: number;
    recentMinutes: number;
}): number {
    const total = Math.max(0, input.sightings ?? 0);
    const recent = Math.max(0, Math.min(input.recentSightings ?? 0, total));
    const windowMinutes = input.windowMinutes ?? 0;
    const recentMinutes = input.recentMinutes ?? 0;

    const baselineMinutes = windowMinutes - recentMinutes;
    // A recent slice as long as the window leaves nothing to compare against.
    if (recentMinutes <= 0 || baselineMinutes <= 0) return 1;
    if (total === 0) return 1;

    const recentRate = recent / recentMinutes;
    const baselineRate = (total - recent) / baselineMinutes;
    const flooredBaseline = Math.max(baselineRate, 1 / baselineMinutes);

    const ratio = recentRate / flooredBaseline;
    return Number.isFinite(ratio) ? ratio : 1;
}

/**
 * Scores every label against every other label in the same window.
 *
 * Relative by construction: a meta is hot compared to what else is running right now, not against a
 * fixed threshold. An absolute cutoff would report the entire chain as cold on a quiet night and as
 * hot during a mania, in both cases telling us nothing about which theme to prefer.
 */
export function computeHeat(
    aggregates: ReadonlyArray<MetaAggregate>,
    options: Partial<HeatOptions> = {},
): Map<string, MetaHeat> {
    const opts: HeatOptions = { ...DEFAULT_HEAT_OPTIONS, ...options };
    const result = new Map<string, MetaHeat>();
    if (aggregates.length === 0) return result;

    const sightings = aggregates.map((a) => a.sightings ?? 0);
    const volumes = aggregates.map((a) => a.volumeSum ?? 0);
    const boosts = aggregates.map((a) => a.boostCount ?? 0);
    const socials = aggregates.map((a) => a.socialScore ?? 0);
    const accelerations = aggregates.map((a) =>
        computeAcceleration({
            sightings: a.sightings ?? 0,
            recentSightings: a.recentSightings ?? 0,
            windowMinutes: a.windowMinutes ?? 0,
            recentMinutes: a.recentMinutes ?? 0,
        }),
    );

    // Only labels that cleared the sample bar take part in the P&L ranking. Including the rest
    // would rank a label with two trades against one with sixty as if the numbers were comparable.
    const eligible = aggregates.filter((a) => (a.trades ?? 0) >= opts.minTradeSample);
    const pnlPerTrade = eligible.map((a) => safeDivide(a.netPnlTotal ?? 0, a.trades ?? 0));

    const activityWeightTotal =
        opts.weightSightings +
        opts.weightVolume +
        opts.weightBoost +
        opts.weightSocial +
        opts.weightAccel;

    for (const [position, aggregate] of aggregates.entries()) {
        const reasons: string[] = [];
        const accelRatio = accelerations[position];

        const pctSightings = percentileRank(sightings, aggregate.sightings ?? 0);
        const pctVolume = percentileRank(volumes, aggregate.volumeSum ?? 0);
        const pctBoost = percentileRank(boosts, aggregate.boostCount ?? 0);
        const pctSocial = percentileRank(socials, aggregate.socialScore ?? 0);
        const pctAccel = percentileRank(accelerations, accelRatio);

        const weightedActivity =
            opts.weightSightings * pctSightings +
            opts.weightVolume * pctVolume +
            opts.weightBoost * pctBoost +
            opts.weightSocial * pctSocial +
            opts.weightAccel * pctAccel;
        // Normalising by the weight total keeps the score on a 0..100 scale whatever the operator
        // sets the individual weights to, so the tier percentiles stay meaningful after tuning.
        const activityScore = clamp(safeDivide(weightedActivity, activityWeightTotal), 0, 100);

        const sampleSize = aggregate.trades ?? 0;
        const netPnlPerTrade = safeDivide(aggregate.netPnlTotal ?? 0, sampleSize);
        const winRate = sampleSize > 0 ? safeDivide(aggregate.wins ?? 0, sampleSize) * 100 : 0;
        const hasSample = sampleSize >= opts.minTradeSample;

        let heatScore = activityScore;
        let pnlScore: number | undefined;

        if (hasSample) {
            pnlScore = percentileRank(pnlPerTrade, netPnlPerTrade);
            heatScore = clamp(
                opts.pnlWeight * pnlScore + (1 - opts.pnlWeight) * activityScore,
                0,
                100,
            );
            reasons.push(`pnl ${netPnlPerTrade.toFixed(3)}/trade over ${sampleSize}`);
        } else {
            reasons.push(`activity only (${sampleSize}/${opts.minTradeSample} trades)`);
        }
        reasons.push(`accel ${accelRatio.toFixed(2)}x`);

        result.set(aggregate.label, {
            label: aggregate.label,
            heatScore,
            tier: resolveTier({ heatScore, netPnlPerTrade, hasSample, opts }),
            sampleSize,
            netPnlPerTrade,
            winRate,
            activityScore,
            accelRatio,
            pnlScore,
            reasons,
        });
    }

    return result;
}

/**
 * TOXIC outranks every other tier, and is the one judgement that ignores attention entirely.
 *
 * It requires both a real sample and a negative average -- "proven to lose money", not "quiet". A
 * busy meta that keeps taking money off us is exactly the case a pure attention score gets wrong,
 * and it is the expensive one, so it gets its own tier rather than a merely low score.
 */
function resolveTier(input: {
    heatScore: number;
    netPnlPerTrade: number;
    hasSample: boolean;
    opts: HeatOptions;
}): MetaTier {
    if (input.hasSample && input.netPnlPerTrade < 0) return 'TOXIC';
    if (input.heatScore >= input.opts.hotPercentile) return 'HOT';
    if (input.heatScore <= input.opts.coldPercentile) return 'COLD';
    return 'WARM';
}

/**
 * Score adjustment a tier earns a candidate.
 *
 * Asymmetric on purpose: the toxic penalty is larger than the hot bonus, because being wrong about
 * a hot meta costs a missed trade, while being wrong about a toxic one costs a filled position in
 * something already measured losing money.
 */
export function metaScoreAdjustment(
    tier: MetaTier | undefined,
    bonuses: { hot: number; warm: number; toxicPenalty: number },
): number {
    switch (tier) {
        case 'HOT':
            return bonuses.hot;
        case 'WARM':
            return bonuses.warm;
        case 'TOXIC':
            return -bonuses.toxicPenalty;
        default:
            return 0;
    }
}
