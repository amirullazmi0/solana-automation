/**
 * Advisory narrative judgement for a buy candidate.
 *
 * This is the one job an LLM does better than a threshold: deciding whether a token's name and
 * social footprint read as a credible project riding a live meta, or as template spam. No formula
 * answers that.
 *
 * Two things make it worth adding, both discovered by reading what the existing AI paths receive:
 *
 *   1. No AI path has ever seen the actual social URLs. `checkMarketTraction` captures them, but
 *      every consumer collapses them to Boolean presence flags, so the model could only ever count
 *      links, never judge them. (`isDexPaidUpdated` is literally hasWebsite || hasTwitter ||
 *      hasTelegram, so it adds nothing on top of those flags despite the name.)
 *   2. A model cannot know which meta is hot today — its knowledge has a cutoff. Asking "is this
 *      theme alive" without current evidence just returns a guess. The caller therefore passes a
 *      snapshot of what is being promoted right now, taken from the DexScreener boost feed the
 *      scanner already polls.
 *
 * The authority granted here is deliberately one-directional and narrower than the exit advisor's,
 * because the failure modes are not symmetric: a wrong narrative verdict costs a missed trade,
 * while a wrong exit costs a healthy position closed at a loss — which already happened once.
 */

export type NarrativeVerdict = 'STRONG' | 'NEUTRAL' | 'WEAK';
export type NarrativeConfidence = 'high' | 'medium' | 'low';

export interface NarrativeAdvice {
    verdict: NarrativeVerdict;
    confidenceLevel: NarrativeConfidence;
    /** Short human-readable justification, surfaced in logs so verdicts can be sanity-checked. */
    reasoning: string;
    evaluatedAt: number;
}

/** Everything the model is given. Social URLs are the part no existing AI path receives. */
export interface NarrativeMetrics {
    tokenName: string;
    symbol: string;
    /** Label from the deterministic regex matcher, kept as a free baseline to compare against. */
    deterministicLabel?: string;
    twitterUrl?: string;
    telegramUrl?: string;
    websiteUrl?: string;
    isCommunityTakeover?: boolean;
    ageMinutes: number;
    marketCapUsd: number;
    /** What is being promoted right now, so "live meta" is grounded rather than recalled. */
    trendingDescriptions: string[];
}

const VERDICTS = new Set<string>(['STRONG', 'NEUTRAL', 'WEAK']);
const CONFIDENCES = new Set<string>(['high', 'medium', 'low']);

export const DEFAULT_NARRATIVE_TTL_MS = 24 * 60 * 60 * 1000;

export function narrativeConfidenceRank(level: string | undefined): number {
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

/**
 * Coerces a model response into the advice shape. Anything unrecognised becomes the inert answer
 * (NEUTRAL / low), never the blocking one — a malformed response must not reject a token.
 */
export function normalizeNarrativeAdvice(
    parsed: Partial<NarrativeAdvice> | null | undefined,
    now: number = Date.now(),
): NarrativeAdvice {
    const verdict = VERDICTS.has(String(parsed?.verdict))
        ? (parsed?.verdict as NarrativeVerdict)
        : 'NEUTRAL';
    const confidenceLevel = CONFIDENCES.has(String(parsed?.confidenceLevel))
        ? (parsed?.confidenceLevel as NarrativeConfidence)
        : 'low';

    return {
        verdict,
        confidenceLevel,
        reasoning: String(parsed?.reasoning ?? '').slice(0, 500),
        evaluatedAt: Number.isFinite(Number(parsed?.evaluatedAt))
            ? Number(parsed?.evaluatedAt)
            : now,
    };
}

export function isNarrativeFresh(
    advice: NarrativeAdvice | undefined,
    maxAgeMs: number = DEFAULT_NARRATIVE_TTL_MS,
    now: number = Date.now(),
): advice is NarrativeAdvice {
    if (!advice) return false;
    const limit =
        Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : DEFAULT_NARRATIVE_TTL_MS;
    return now - advice.evaluatedAt <= limit;
}

/**
 * Whether the verdict justifies rejecting this candidate.
 *
 * One-directional by construction. There is no counterpart that lets a STRONG verdict force or
 * ease a buy, so the model can only ever subtract candidates — it can never talk the bot into a
 * trade the deterministic gates did not already approve.
 */
export function shouldRejectOnNarrative(
    advice: NarrativeAdvice | undefined,
    options: {
        enabled?: boolean;
        maxAgeMs?: number;
        minConfidence?: NarrativeConfidence;
        now?: number;
    } = {},
): boolean {
    if (options.enabled !== true) return false;

    const now = options.now ?? Date.now();
    if (!isNarrativeFresh(advice, options.maxAgeMs, now)) return false;
    if (advice.verdict !== 'WEAK') return false;

    return (
        narrativeConfidenceRank(advice.confidenceLevel) >=
        narrativeConfidenceRank(options.minConfidence ?? 'high')
    );
}

/**
 * True when this mint is worth spending an API call on.
 *
 * The caller re-analyses the same mint roughly once a second for up to twelve minutes, so without
 * this check plus an in-flight guard a single token would fire dozens of identical requests.
 */
export function shouldRefreshNarrative(
    advice: NarrativeAdvice | undefined,
    ttlMs: number = DEFAULT_NARRATIVE_TTL_MS,
    now: number = Date.now(),
): boolean {
    if (!advice) return true;
    const limit = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_NARRATIVE_TTL_MS;
    return now - advice.evaluatedAt >= limit;
}

/**
 * Strips markdown code fences before JSON.parse.
 *
 * Every AI path in this repo parses `JSON.parse(content)` directly. That holds only while the model
 * never wraps its answer, which is a property of the specific model rather than of the API — and
 * the model is a config knob the operator is expected to change. A wrapped response currently
 * throws and degrades silently to the fallback.
 */
export function stripJsonFence(content: string): string {
    const trimmed = String(content ?? '').trim();
    if (!trimmed.startsWith('```')) return trimmed;

    const withoutOpen = trimmed.replace(/^```[a-z]*/i, '');
    const closeAt = withoutOpen.lastIndexOf('```');
    return (closeAt >= 0 ? withoutOpen.slice(0, closeAt) : withoutOpen).trim();
}
