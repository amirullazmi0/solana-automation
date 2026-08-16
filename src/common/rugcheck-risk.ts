import { RugCheckRisk } from '../dto/analyzer.dto';

/**
 * RugCheck's `score` is an unbounded raw sum, not a 0-100 rating: a single "Low Liquidity" risk
 * on a freshly migrated pump.fun token contributes ~2978 on its own. Comparing that raw number
 * against a 1000 threshold rejected essentially every migration — including $3Zrpw7RW, whose
 * holder spread was near-perfect (single 0.05%, top10 0.1%) and whose `score_normalised` was 34.
 *
 * `score_normalised` is the bounded 0-100 rating meant for exactly this comparison.
 */
export const DEFAULT_MAX_NORMALISED_RISK_SCORE = 60;

/**
 * Risks the bot already evaluates itself, and therefore must not ALSO treat as a permanent
 * RugCheck blacklist. Liquidity is enforced directly by MIN_LIQUIDITY_USD plus the hard
 * sub-$1000 reject, both of which are stricter and fresher than RugCheck's label.
 */
const SELF_ENFORCED_RISK_PATTERNS = [/low\s*liquidity/i, /low\s*amount\s*of\s*liquidity/i];

export function isSelfEnforcedRisk(riskName: string | undefined): boolean {
    const name = String(riskName ?? '');
    return SELF_ENFORCED_RISK_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Danger-level risks that should still block a buy: everything RugCheck flags as `danger`
 * except the ones this bot enforces on its own.
 */
export function selectBlockingDangerRisks(risks: RugCheckRisk[] | undefined): RugCheckRisk[] {
    return (risks || []).filter(
        (risk) => risk.level === 'danger' && !isSelfEnforcedRisk(risk.name),
    );
}

/**
 * Prefers the bounded rating and falls back to "no opinion" (0) rather than to the raw score,
 * so a missing field can never resurrect the raw-vs-threshold mismatch this replaced.
 */
export function resolveNormalisedRiskScore(scoreNormalised: number | undefined): number {
    const normalised = Number(scoreNormalised);
    return Number.isFinite(normalised) && normalised >= 0 ? normalised : 0;
}

export function exceedsRiskScore(
    scoreNormalised: number | undefined,
    maxNormalisedScore: number = DEFAULT_MAX_NORMALISED_RISK_SCORE,
): boolean {
    const max = Number(maxNormalisedScore);
    const limit = Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_NORMALISED_RISK_SCORE;
    return resolveNormalisedRiskScore(scoreNormalised) > limit;
}

/**
 * RugCheck needs a few minutes after a migration before its holder table settles: the same
 * token reported single=79.33% seconds after migrating and 0.05% once the pool was labelled.
 * Rejecting on that early snapshot is fine; making the rejection PERMANENT is not, because the
 * token can never be reconsidered once the data matures.
 */
export const DEFAULT_HOLDER_DATA_SETTLE_MINUTES = 10;

export function isHolderDataSettled(
    tokenAgeMs: number | undefined,
    settleMinutes: number = DEFAULT_HOLDER_DATA_SETTLE_MINUTES,
): boolean {
    const ageMs = Number(tokenAgeMs);
    if (!Number.isFinite(ageMs) || ageMs <= 0) return true; // Unknown age: keep prior behaviour.
    const minutes = Number(settleMinutes);
    const window = Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_HOLDER_DATA_SETTLE_MINUTES;
    return ageMs >= window * 60 * 1000;
}
