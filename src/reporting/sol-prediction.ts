/**
 * A directional call on SOL over a fixed horizon, and the machinery that grades it afterwards.
 *
 * Short-horizon price direction is very likely not predictable, and the most probable outcome here
 * is a hit rate near chance. The design does not ask anyone to take the signal on faith: every call
 * is written down before the outcome is known, scored once the horizon passes, and the running hit
 * rate is printed next to each new prediction alongside two baselines. If the signal is worth
 * something the numbers will show it; if it is not, the numbers will show that too, which is a real
 * answer rather than an argument.
 *
 * What makes this worth attempting at all is not the SOL price -- everyone has that. It is the
 * memecoin census this bot already runs: hundreds of tokens scanned per day, their volume and
 * one-hour price change already persisted. That is a direct read on retail risk appetite on Solana,
 * and it turns more often than SOL does.
 *
 * The scoring model is deliberately a readable weighted sum rather than anything opaque. When the
 * hit rate comes back at 50% we need to see which term dragged; an unreadable model leaves only
 * guesses. No LLM is involved: for price direction a language model adds nothing and costs latency.
 */

export type Direction = 'UP' | 'DOWN' | 'FLAT';
export type Confidence = 'weak' | 'medium' | 'strong';

export const CONFIDENCE_ORDER: Confidence[] = ['weak', 'medium', 'strong'];

/**
 * Everything the model looks at. Every field is optional because a field that has not been observed
 * long enough must be absent rather than zero -- a missing measurement and a measurement of zero
 * mean opposite things, and conflating them is how a feature quietly votes when it has no opinion.
 */
export interface PredictionFeatures {
    solChange5mPct?: number;
    solChange15mPct?: number;
    solChange60mPct?: number;
    /** Standard deviation of sample-to-sample returns, in percent. Dampens confidence. */
    solVolatilityPct?: number;
    /** Mean one-hour price change across recently scanned memecoins. */
    memeBreadthPct?: number;
    /** Recent memecoin volume over its earlier baseline. 1.0 means unchanged. */
    memeVolumeAccel?: number;
    /** Share of recently seen tokens that were paid promotions, 0..1. */
    boostShare?: number;
}

export interface PredictionOptions {
    weightMomentum: number;
    weightBreadth: number;
    weightVolume: number;
    weightBoost: number;
    /** Moves smaller than this count as FLAT, both when predicting and when grading. */
    flatBandPct: number;
    /** |score| needed for each confidence tier. */
    mediumScore?: number;
    strongScore?: number;
}

export interface PredictionResult {
    direction: Direction;
    confidence: Confidence;
    /** Blended signal in -1..+1. Negative leans down. */
    score: number;
    reasons: string[];
}

export const DEFAULT_PREDICTION_OPTIONS: PredictionOptions = {
    weightMomentum: 0.35,
    weightBreadth: 0.3,
    weightVolume: 0.25,
    weightBoost: 0.1,
    flatBandPct: 0.5,
    mediumScore: 0.25,
    strongScore: 0.5,
};

function isNum(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, low: number, high: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(low, Math.min(high, value));
}

/** Maps a raw reading onto -1..+1, saturating at `full`. Keeps unlike units comparable. */
function normalise(value: number, full: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(full) || full <= 0) return 0;
    return clamp(value / full, -1, 1);
}

/**
 * Blends the three SOL lookbacks into one momentum reading.
 *
 * The short window is weighted least. A one-minute spike is mostly noise at a thirty-minute
 * horizon, while the hour tells you what regime you are actually in -- but the hour alone turns too
 * late to be worth acting on, so all three contribute.
 *
 * Saturation points widen with the window because a 1% move over five minutes and a 1% move over an
 * hour are not the same event.
 */
function momentumSignal(features: PredictionFeatures): { signal: number; parts: number } {
    const terms: Array<{ value: number; weight: number }> = [];
    if (isNum(features.solChange5mPct)) {
        terms.push({ value: normalise(features.solChange5mPct, 1), weight: 0.2 });
    }
    if (isNum(features.solChange15mPct)) {
        terms.push({ value: normalise(features.solChange15mPct, 2), weight: 0.45 });
    }
    if (isNum(features.solChange60mPct)) {
        terms.push({ value: normalise(features.solChange60mPct, 4), weight: 0.35 });
    }
    if (terms.length === 0) return { signal: 0, parts: 0 };

    const weightTotal = terms.reduce((sum, t) => sum + t.weight, 0);
    const weighted = terms.reduce((sum, t) => sum + t.value * t.weight, 0);
    return { signal: weighted / weightTotal, parts: terms.length };
}

/**
 * The directional call, or undefined when there is not enough to say anything.
 *
 * Returning undefined rather than a low-confidence guess is the point. The same mistake was made in
 * the meta feature: `computeAcceleration` assumed the nominal window length, so moments after a
 * restart every label reported the same fabricated constant. A predictor with a three-minute buffer
 * reporting on a thirty-minute horizon would be that bug wearing a different hat.
 */
export function predictSolDirection(
    features: PredictionFeatures,
    options: Partial<PredictionOptions> = {},
): PredictionResult | undefined {
    const opts: PredictionOptions = { ...DEFAULT_PREDICTION_OPTIONS, ...options };

    // The fifteen-minute SOL change is mandatory: it is the backbone of the momentum term, and
    // without it the model would be voting almost entirely on memecoin flow.
    if (!isNum(features.solChange15mPct)) return undefined;

    const reasons: string[] = [];
    const contributions: Array<{ value: number; weight: number }> = [];

    const momentum = momentumSignal(features);
    if (momentum.parts > 0) {
        contributions.push({ value: momentum.signal, weight: Math.max(0, opts.weightMomentum) });
        reasons.push(`sol momentum ${momentum.signal.toFixed(2)}`);
    }

    if (isNum(features.memeBreadthPct)) {
        // Memecoins swing far harder than SOL, so the saturation point is much wider.
        const breadth = normalise(features.memeBreadthPct, 10);
        contributions.push({ value: breadth, weight: Math.max(0, opts.weightBreadth) });
        reasons.push(`meme breadth ${breadth.toFixed(2)}`);
    }

    if (isNum(features.memeVolumeAccel)) {
        // Centred on 1.0: flow unchanged is no opinion, doubling is a full positive reading.
        const flow = normalise(features.memeVolumeAccel - 1, 1);
        contributions.push({ value: flow, weight: Math.max(0, opts.weightVolume) });
        reasons.push(`meme flow ${flow.toFixed(2)}`);
    }

    if (isNum(features.boostShare)) {
        // Centred on a 15% baseline share of paid promotion. Above it reads as risk-on.
        const boost = normalise(features.boostShare - 0.15, 0.15);
        contributions.push({ value: boost, weight: Math.max(0, opts.weightBoost) });
        reasons.push(`boost ${boost.toFixed(2)}`);
    }

    const weightTotal = contributions.reduce((sum, c) => sum + c.weight, 0);
    if (weightTotal <= 0) return undefined;

    let score = clamp(
        contributions.reduce((sum, c) => sum + c.value * c.weight, 0) / weightTotal,
        -1,
        1,
    );

    // Volatility never points anywhere. It only makes the call less certain: the same score in a
    // violent tape deserves less confidence than in a quiet one, and treating it as directional
    // would have it pushing whichever way the last tick happened to go.
    let volatilityPenalty = 1;
    if (isNum(features.solVolatilityPct) && features.solVolatilityPct > 0) {
        volatilityPenalty = clamp(1 - normalise(features.solVolatilityPct, 3) * 0.5, 0.4, 1);
        reasons.push(`vol damp ${volatilityPenalty.toFixed(2)}`);
    }
    score = clamp(score * volatilityPenalty, -1, 1);

    const medium = opts.mediumScore ?? 0.25;
    const strong = opts.strongScore ?? 0.5;
    const magnitude = Math.abs(score);

    // Below the medium bar the model is not claiming a direction at all. FLAT is a real answer
    // here, not a failure to decide.
    const direction: Direction = magnitude < medium ? 'FLAT' : score > 0 ? 'UP' : 'DOWN';
    const confidence: Confidence =
        magnitude >= strong ? 'strong' : magnitude >= medium ? 'medium' : 'weak';

    return { direction, confidence, score, reasons };
}

/** Which way the market actually went, using the same flat band the prediction was made under. */
export function resolveActualDirection(changePct: number, flatBandPct: number): Direction {
    if (!isNum(changePct)) return 'FLAT';
    const band = isNum(flatBandPct) && flatBandPct > 0 ? flatBandPct : 0;
    if (Math.abs(changePct) < band) return 'FLAT';
    return changePct > 0 ? 'UP' : 'DOWN';
}

/**
 * Grades one prediction.
 *
 * The flat band applies to the outcome as well as the call. Without it "correct" could mean SOL
 * moved 0.02%, and the hit rate would measure nothing but rounding.
 */
export function scorePrediction(input: {
    direction: Direction;
    changePct: number;
    flatBandPct: number;
}): boolean {
    return input.direction === resolveActualDirection(input.changePct, input.flatBandPct);
}

export interface ResolvedPrediction {
    direction: Direction;
    confidence: Confidence;
    actualChangePct: number;
    madeAt: number;
}

export interface AccuracySummary {
    total: number;
    correct: number;
    hitRate: number;
    /** How often simply always answering FLAT would have been right. */
    baselineAlwaysFlat: number;
    /** How often "the next move continues the last one" would have been right. */
    baselinePersistence: number;
    byConfidence: Record<Confidence, { total: number; hitRate: number }>;
}

/**
 * Hit rate, plus the two baselines that decide whether it means anything.
 *
 * A bare accuracy figure is close to useless. 55% sounds like an edge right up until you notice
 * that always guessing FLAT scored 58% on the same rows, which is exactly the trap a
 * confident-looking number invites. Both baselines are therefore computed from the same set and
 * reported next to the headline, always.
 */
export function summariseAccuracy(
    rows: ReadonlyArray<ResolvedPrediction>,
    flatBandPct: number,
): AccuracySummary {
    const empty: AccuracySummary = {
        total: 0,
        correct: 0,
        hitRate: 0,
        baselineAlwaysFlat: 0,
        baselinePersistence: 0,
        byConfidence: {
            weak: { total: 0, hitRate: 0 },
            medium: { total: 0, hitRate: 0 },
            strong: { total: 0, hitRate: 0 },
        },
    };
    if (rows.length === 0) return empty;

    const ordered = [...rows].sort((a, b) => a.madeAt - b.madeAt);
    const actuals = ordered.map((r) => resolveActualDirection(r.actualChangePct, flatBandPct));

    let correct = 0;
    let flatHits = 0;
    let persistenceHits = 0;
    let persistenceTotal = 0;
    const byConfidence = { ...empty.byConfidence };
    const tally: Record<Confidence, { total: number; correct: number }> = {
        weak: { total: 0, correct: 0 },
        medium: { total: 0, correct: 0 },
        strong: { total: 0, correct: 0 },
    };

    for (let i = 0; i < ordered.length; i += 1) {
        const hit = ordered[i].direction === actuals[i];
        if (hit) correct += 1;
        if (actuals[i] === 'FLAT') flatHits += 1;

        // Persistence needs something before it to continue, so the first row cannot be scored.
        if (i > 0) {
            persistenceTotal += 1;
            if (actuals[i - 1] === actuals[i]) persistenceHits += 1;
        }

        const bucket = tally[ordered[i].confidence];
        if (bucket) {
            bucket.total += 1;
            if (hit) bucket.correct += 1;
        }
    }

    for (const level of CONFIDENCE_ORDER) {
        const t = tally[level];
        byConfidence[level] = {
            total: t.total,
            hitRate: t.total > 0 ? (t.correct / t.total) * 100 : 0,
        };
    }

    return {
        total: ordered.length,
        correct,
        hitRate: (correct / ordered.length) * 100,
        baselineAlwaysFlat: (flatHits / ordered.length) * 100,
        baselinePersistence:
            persistenceTotal > 0 ? (persistenceHits / persistenceTotal) * 100 : 0,
        byConfidence,
    };
}

export interface AlertGateOptions {
    /** Resolved predictions required before the signal may say anything at all. */
    minSample: number;
    /** Percentage points the hit rate must clear the best baseline by. */
    minEdgePoints: number;
}

export interface AlertGateDecision {
    allowed: boolean;
    reason: string;
    edgePoints: number;
    bestBaseline: number;
}

/**
 * Whether the predictor has earned the right to send messages.
 *
 * The gate is measured rather than switched on by hand, because the honest version of "tell me when
 * SOL is about to move" is "tell me only once you can show you know". A pre-ship backtest over 94
 * calls on real prices scored 73.4% against a 78.7% always-FLAT baseline, and 11% on the nine calls
 * where it actually picked a side -- so on current evidence this gate is closed, and it should be.
 *
 * Two conditions, both necessary. The sample floor stops a lucky run of five from unlocking
 * alerts. The margin is measured against the BEST of the two baselines, not against 50%, because
 * beating a coin flip is meaningless when doing nothing scores 78%.
 */
export function shouldStartAlerting(
    summary: AccuracySummary,
    options: AlertGateOptions,
): AlertGateDecision {
    const minSample = Math.max(1, options.minSample);
    const minEdge = Math.max(0, options.minEdgePoints);
    const bestBaseline = Math.max(summary.baselineAlwaysFlat, summary.baselinePersistence);
    const edgePoints = summary.hitRate - bestBaseline;

    if (summary.total < minSample) {
        return {
            allowed: false,
            reason: `mengumpulkan data (${summary.total}/${minSample} prediksi)`,
            edgePoints,
            bestBaseline,
        };
    }
    if (edgePoints < minEdge) {
        return {
            allowed: false,
            reason:
                `belum mengalahkan baseline (${summary.hitRate.toFixed(1)}% vs ` +
                `${bestBaseline.toFixed(1)}%, butuh +${minEdge})`,
            edgePoints,
            bestBaseline,
        };
    }
    return {
        allowed: true,
        reason: `unggul +${edgePoints.toFixed(1)} poin atas baseline dari ${summary.total} prediksi`,
        edgePoints,
        bestBaseline,
    };
}

/** Whether a call clears the minimum confidence configured for sending a message. */
export function meetsMinimumConfidence(actual: Confidence, minimum: Confidence): boolean {
    return CONFIDENCE_ORDER.indexOf(actual) >= CONFIDENCE_ORDER.indexOf(minimum);
}
