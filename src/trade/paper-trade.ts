/**
 * Paper trading arithmetic, with no I/O and no database.
 *
 * The point of a simulation is to be wrong in the same direction as reality, never in the flattering
 * one. Two things decide whether that holds, and both are modelled here rather than assumed away:
 *
 * Fees are charged on both legs. A round trip costs roughly 0.0011 SOL, which is 2.6% of a $5
 * position and 6.6% of a $2 one. A simulation that skips them turns a losing strategy into a
 * winning-looking one at exactly the position sizes this bot uses.
 *
 * Entry slippage is charged against the buyer. A paper fill at the quoted price is a fill nobody
 * ever gets, and the gap is widest on precisely the fast-moving tokens a momentum gate selects for.
 *
 * What this cannot model is whether the swap would have filled at all. A paper entry always
 * succeeds; a real one is rejected when the price moves past the slippage tolerance. So these
 * numbers are worth reading for direction and comparison -- which meta loses money, which exit
 * works, whether a 20% target is too far -- and not as the dollars that would have been earned.
 */

export type PaperExitReason = 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP' | 'MAX_HOLD' | 'PANIC';

export interface PaperEntryInput {
    /** Quoted price per token, in USD. */
    priceUsd: number;
    positionSizeUsd: number;
    /** Slippage tolerance in basis points, the same value the real swap would be given. */
    slippageBps: number;
    /** Round-trip fee in SOL. Half is charged at entry, half at exit. */
    roundTripFeeSol: number;
}

export interface PaperEntry {
    /** Price actually paid per token, worse than quoted by the slippage assumption. */
    fillPriceUsd: number;
    tokenAmount: number;
    /** USD actually committed, before fees. */
    costUsd: number;
    entryFeeSol: number;
}

export interface PaperExitInput {
    entryFillPriceUsd: number;
    currentPriceUsd: number;
    /** Highest price seen since entry, in USD. Pass the entry price on the first tick. */
    highestPriceUsd: number;
    targetTakeProfitPercent: number;
    targetStopLossPercent: number;
    targetTrailingDistancePercent: number;
    ageMinutes: number;
    maxHoldMinutes: number;
}

export interface PaperExitDecision {
    shouldExit: boolean;
    reason?: PaperExitReason;
    profitPercent: number;
    /** Carried forward so the caller can persist it for the next tick. */
    highestPriceUsd: number;
    trailingStopPriceUsd: number;
}

export interface PaperResultInput {
    entry: PaperEntry;
    exitPriceUsd: number;
    roundTripFeeSol: number;
}

export interface PaperResult {
    /** Before fees, so it lines up with the `profitUsd` column on a live trade. */
    profitUsd: number;
    /** Total fees for the round trip, in SOL, for the `totalFeesSol` column. */
    totalFeesSol: number;
    exitValueUsd: number;
}

/**
 * A loss this deep is treated as a structural failure rather than a stop being hit, mirroring the
 * hard panic in the live monitor.
 */
const PANIC_LOSS_PERCENT = -55;

/**
 * Tolerance for comparing a percentage against its threshold.
 *
 * An exact 20% move does not read as 20% in binary floating point: a price of 0.0012 against an
 * entry of 0.001 computes to 19.999999999999996, so a plain `>= 20` leaves a take profit set at 20%
 * silently unarmed at exactly 20%. It would fire on the next tick if price kept going, and never at
 * all if price turned around on the target -- which is precisely when the exit mattered.
 *
 * A billionth of a percentage point is far below any price move worth reacting to, so this closes
 * the gap without loosening the threshold in any way a reader would notice.
 */
const PERCENT_EPSILON = 1e-9;

export function simulatePaperEntry(input: PaperEntryInput): PaperEntry {
    const { priceUsd, positionSizeUsd, slippageBps, roundTripFeeSol } = input;

    if (!(priceUsd > 0) || !(positionSizeUsd > 0)) {
        return { fillPriceUsd: 0, tokenAmount: 0, costUsd: 0, entryFeeSol: 0 };
    }

    // The full tolerance is assumed to be consumed. A buyer who is given 0.5% of room and models
    // zero of it has simply chosen the flattering end of a range they do not control.
    const slip = Math.max(0, slippageBps) / 10_000;
    const fillPriceUsd = priceUsd * (1 + slip);

    return {
        fillPriceUsd,
        tokenAmount: positionSizeUsd / fillPriceUsd,
        costUsd: positionSizeUsd,
        entryFeeSol: Math.max(0, roundTripFeeSol) / 2,
    };
}

export function decidePaperExit(input: PaperExitInput): PaperExitDecision {
    const {
        entryFillPriceUsd,
        currentPriceUsd,
        targetTakeProfitPercent,
        targetStopLossPercent,
        targetTrailingDistancePercent,
        ageMinutes,
        maxHoldMinutes,
    } = input;

    const highestPriceUsd = Math.max(input.highestPriceUsd, currentPriceUsd);

    if (!(entryFillPriceUsd > 0) || !(currentPriceUsd > 0)) {
        return { shouldExit: false, profitPercent: 0, highestPriceUsd, trailingStopPriceUsd: 0 };
    }

    const profitPercent = ((currentPriceUsd - entryFillPriceUsd) / entryFillPriceUsd) * 100;
    const trailingStopPriceUsd =
        highestPriceUsd * (1 - Math.max(0, targetTrailingDistancePercent) / 100);

    const base = { profitPercent, highestPriceUsd, trailingStopPriceUsd };

    // Same priority as the live monitor: panic, then the stop, then the target, then the trail.
    // Mirroring the order matters more than it looks -- evaluating take profit before stop loss
    // would measure a different strategy than the one actually running.
    if (profitPercent <= PANIC_LOSS_PERCENT + PERCENT_EPSILON) {
        return { ...base, shouldExit: true, reason: 'PANIC' };
    }
    if (profitPercent <= -Math.abs(targetStopLossPercent) + PERCENT_EPSILON) {
        return { ...base, shouldExit: true, reason: 'STOP_LOSS' };
    }
    if (profitPercent >= targetTakeProfitPercent - PERCENT_EPSILON) {
        return { ...base, shouldExit: true, reason: 'TAKE_PROFIT' };
    }
    // The trail only arms once price has been above entry; otherwise a tight distance would fire
    // immediately on a position that never went anywhere.
    if (
        targetTrailingDistancePercent > 0 &&
        highestPriceUsd > entryFillPriceUsd &&
        currentPriceUsd <= trailingStopPriceUsd
    ) {
        return { ...base, shouldExit: true, reason: 'TRAILING_STOP' };
    }
    // Without this a position that never reaches any threshold stays open forever and quietly
    // poisons every average computed over closed trades.
    if (maxHoldMinutes > 0 && ageMinutes >= maxHoldMinutes) {
        return { ...base, shouldExit: true, reason: 'MAX_HOLD' };
    }

    return { ...base, shouldExit: false };
}

export function computePaperResult(input: PaperResultInput): PaperResult {
    const { entry, exitPriceUsd, roundTripFeeSol } = input;

    if (!(entry.tokenAmount > 0) || !(exitPriceUsd > 0)) {
        return { profitUsd: 0, totalFeesSol: Math.max(0, roundTripFeeSol), exitValueUsd: 0 };
    }

    const exitValueUsd = entry.tokenAmount * exitPriceUsd;

    return {
        // Gross, matching the `profitUsd` column. The fee subtraction is left to
        // `computeNetProfitUsd` so paper and live P&L go through one definition rather than two
        // that can drift apart.
        profitUsd: exitValueUsd - entry.costUsd,
        totalFeesSol: Math.max(0, roundTripFeeSol),
        exitValueUsd,
    };
}

/**
 * Whether the live buy gate would have refused this signal because the price ran away from it.
 *
 * `evaluateBuySignalGuard` in TradeService rejects a buy when the executable price has climbed more
 * than `MAX_BUY_CHASE_PCT` above the price the signal was raised at. Without the same check here the
 * simulation opens positions the live bot structurally cannot open, and every number drawn from
 * them describes a strategy nobody runs.
 *
 * The threshold is passed in rather than read, and the key name is duplicated in the service rather
 * than imported, because TradeService sits on the money path and this module deliberately has no
 * reference to it. `paper-trade.service.spec.ts` asserts both sides name the same config key, so the
 * duplication cannot drift unnoticed.
 */
export function wouldChasePrice(
    signalPriceUsd: number,
    executablePriceUsd: number,
    maxChasePercent: number,
): boolean {
    if (!(signalPriceUsd > 0) || !(executablePriceUsd > 0)) return false;
    return executablePriceUsd > signalPriceUsd * (1 + Math.max(0, maxChasePercent) / 100);
}
