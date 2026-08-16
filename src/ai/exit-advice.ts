/**
 * Advisory AI for the exit side of a position.
 *
 * The bot already ran an LLM inside the stop-loss path once, via `evaluateCutlossDefense`, whose
 * purpose was to EXTEND the stop and postpone the sell. Across the four production trades that
 * exited as AI_STOP_LOSS_CONFIRMED the result was 0 wins and -$4.03 gross, an average loss of
 * -$1.01 against a -$0.52 average for every other losing trade. Meanwhile AI_HEALTH_CRITICAL,
 * which exits EARLIER, went 3 wins of 4 for +$0.47.
 *
 * The asymmetry is the whole design rationale here:
 *
 *   1. Advice is produced OFF the execution path and read from cache, so consulting it costs
 *      zero milliseconds when a trailing update or a sell actually fires. $PILLY lost 39.84
 *      percentage points between its trigger and its fill; there is no budget for a network
 *      round trip in that window.
 *   2. Advice may only ever TIGHTEN — shrink the trailing distance or exit sooner. It can never
 *      widen a trail, postpone a sell, or lower a stop. A stale or hallucinated response can
 *      therefore cost an early exit, never an uncapped loss.
 */

export type AiExitBias = 'HOLD' | 'TIGHTEN' | 'EXIT_NOW';
export type AiConfidenceLevel = 'high' | 'medium' | 'low';

export interface AiExitAdvice {
    bias: AiExitBias;
    /** Suggested trailing distance in percent. Only honoured when tighter than the current one. */
    trailingDistancePercent?: number;
    confidenceLevel: AiConfidenceLevel;
    reasoning: string;
    updatedAt: number;
}

export interface AiExitAdviceMetrics {
    profitPercent: number;
    stopLossPercent: number;
    trailingDistancePercent: number;
    trailingArmed: boolean;
    ageMinutes: number;
    liquidityUsd: number;
    entryLiquidityUsd: number;
    volume5mUsd: number;
    buys5mCount: number;
    sells5mCount: number;
    priceChange5mPct: number;
    priceChange1hPct: number;
    volScore: number;
    route: string;
}

const BIASES: readonly AiExitBias[] = ['HOLD', 'TIGHTEN', 'EXIT_NOW'];
const CONFIDENCES: readonly AiConfidenceLevel[] = ['high', 'medium', 'low'];

export const DEFAULT_EXIT_ADVICE_MAX_AGE_MS = 90_000;
export const DEFAULT_EXIT_ADVICE_REFRESH_MS = 20_000;

/** Ranked so a minimum-confidence gate can be expressed as a simple comparison. */
export function confidenceRank(level: AiConfidenceLevel | string | undefined): number {
    switch (String(level ?? '').toLowerCase()) {
        case 'high':
            return 3;
        case 'medium':
            return 2;
        case 'low':
            return 1;
        default:
            return 0;
    }
}

export function normalizeExitAdvice(
    parsed: Partial<AiExitAdvice> & { trailingDistancePercent?: unknown },
    now: number = Date.now(),
): AiExitAdvice {
    const bias = BIASES.includes(parsed.bias as AiExitBias) ? (parsed.bias as AiExitBias) : 'HOLD';
    const confidenceLevel = CONFIDENCES.includes(parsed.confidenceLevel as AiConfidenceLevel)
        ? (parsed.confidenceLevel as AiConfidenceLevel)
        : 'low';
    const rawTrail = Number(parsed.trailingDistancePercent);
    // A trail outside this band is a malformed answer, not a tighter one; drop it rather than
    // letting a 0% trail stop the position out on the next tick.
    const trailingDistancePercent =
        Number.isFinite(rawTrail) && rawTrail >= 0.5 && rawTrail <= 50 ? rawTrail : undefined;

    return {
        bias,
        trailingDistancePercent,
        confidenceLevel,
        reasoning: String(parsed.reasoning ?? '').slice(0, 500),
        updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : now,
    };
}

export function isAdviceFresh(
    advice: AiExitAdvice | undefined,
    maxAgeMs: number = DEFAULT_EXIT_ADVICE_MAX_AGE_MS,
    now: number = Date.now(),
): advice is AiExitAdvice {
    if (!advice) return false;
    const limit = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_EXIT_ADVICE_MAX_AGE_MS;
    return now - advice.updatedAt <= limit;
}

/**
 * Returns the trailing distance to actually use. The AI may only narrow it: whatever the model
 * says, the result is never wider than the distance the deterministic logic already chose.
 */
export function resolveAdvisedTrailingDistance(
    currentDistancePercent: number,
    advice: AiExitAdvice | undefined,
    options: { maxAgeMs?: number; minConfidence?: AiConfidenceLevel; now?: number } = {},
): number {
    const current = Number(currentDistancePercent);
    if (!Number.isFinite(current) || current <= 0) return currentDistancePercent;

    const now = options.now ?? Date.now();
    if (!isAdviceFresh(advice, options.maxAgeMs, now)) return current;
    if (confidenceRank(advice.confidenceLevel) < confidenceRank(options.minConfidence ?? 'medium')) {
        return current;
    }

    const suggested = advice.trailingDistancePercent;
    if (!Number.isFinite(Number(suggested))) return current;
    return Math.min(current, Number(suggested));
}

/**
 * Whether the cached advice justifies exiting ahead of the deterministic triggers. Deliberately
 * one-directional: there is no counterpart that permits holding past a trigger.
 */
export function shouldExitEarly(
    advice: AiExitAdvice | undefined,
    options: { maxAgeMs?: number; minConfidence?: AiConfidenceLevel; now?: number } = {},
): boolean {
    const now = options.now ?? Date.now();
    if (!isAdviceFresh(advice, options.maxAgeMs, now)) return false;
    if (advice.bias !== 'EXIT_NOW') return false;
    return confidenceRank(advice.confidenceLevel) >= confidenceRank(options.minConfidence ?? 'high');
}

/** True when enough time has passed to spend another API call on this position. */
export function shouldRefreshAdvice(
    advice: AiExitAdvice | undefined,
    refreshMs: number = DEFAULT_EXIT_ADVICE_REFRESH_MS,
    now: number = Date.now(),
): boolean {
    if (!advice) return true;
    const interval = Number.isFinite(refreshMs) && refreshMs > 0 ? refreshMs : DEFAULT_EXIT_ADVICE_REFRESH_MS;
    return now - advice.updatedAt >= interval;
}
