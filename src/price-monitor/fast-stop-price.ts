/**
 * A second, faster price opinion, used by the stop loss and by nothing else.
 *
 * The monitor ticks once a second but reads DexScreener, which was measured refreshing its pair
 * price roughly once every 26 seconds -- three changes across 84 one-second samples, worst gap
 * 30.3s -- while Jupiter moved about every 6 seconds and the two disagreed by as much as 25% at a
 * given instant. Polling a number that does not move cannot detect a fall in time, and production
 * bears that out: stops configured at -8% recorded an average trigger of -17.1%, and the overshoot
 * was flat across every entry-liquidity bucket (-18.7% under $15k, -17.0% at $25-50k), which rules
 * out slippage and thin pools and leaves late detection as the cause.
 *
 * Scoped to the stop on purpose. `TRAILING_DISTANCE_PERCENT` is 0.8, a figure only survivable
 * because a stale feed smooths out noise, and trailing exits are the one profitable path in
 * production (+$15.06 across 26 trades at +32.4% average). Handing them a six-second price would
 * trip them on ordinary jitter and destroy the only thing that works.
 */

export interface StopProfitInput {
    /** P&L on the existing DexScreener basis, in percent. */
    basisProfitPercent: number;
    /** Fresh price in USD, or undefined when no fresh quote is available. */
    fastPriceUsd?: number;
    entryPriceSol: number;
    currentSolUsd: number;
    enabled: boolean;
}

export interface StopProfitResult {
    /** The number the stop condition is judged on. */
    stopProfitPercent: number;
    /** What the fast source thought, when it had an opinion. Logged, never acted on alone. */
    fastProfitPercent?: number;
}

/**
 * The more pessimistic of the two views.
 *
 * One-directional by construction: taking the minimum lets a fresher price bring the stop forward
 * but never hold it back. A stale, missing or nonsensical quote therefore leaves the decision
 * exactly where it is today, and a disagreeing one can never talk the bot out of an exit the
 * existing basis already wants. Every failure mode degrades to current behaviour rather than to a
 * held-open losing position.
 */
export function resolveStopProfitPercent(input: StopProfitInput): StopProfitResult {
    const basis = Number(input.basisProfitPercent);
    if (!Number.isFinite(basis)) return { stopProfitPercent: 0 };
    if (!input.enabled) return { stopProfitPercent: basis };

    const entryPriceSol = Number(input.entryPriceSol);
    const currentSolUsd = Number(input.currentSolUsd);
    const fastPriceUsd = Number(input.fastPriceUsd);

    if (!Number.isFinite(entryPriceSol) || entryPriceSol <= 0) return { stopProfitPercent: basis };
    if (!Number.isFinite(currentSolUsd) || currentSolUsd <= 0) return { stopProfitPercent: basis };
    if (!Number.isFinite(fastPriceUsd) || fastPriceUsd <= 0) return { stopProfitPercent: basis };

    // Converted into the SOL basis the rest of the evaluation uses. Comparing a USD price against a
    // SOL-denominated entry would fold SOL's own move into the token's, so a SOL rally would read
    // as the token falling and fire the stop on a position that never moved.
    const fastPriceSol = fastPriceUsd / currentSolUsd;
    const fastProfitPercent = ((fastPriceSol - entryPriceSol) / entryPriceSol) * 100;
    if (!Number.isFinite(fastProfitPercent)) return { stopProfitPercent: basis };

    return {
        stopProfitPercent: Math.min(basis, fastProfitPercent),
        fastProfitPercent,
    };
}
