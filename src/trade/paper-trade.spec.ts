import { computeNetProfitUsd } from '../common/fee-utils';
import {
    computePaperResult,
    decidePaperExit,
    simulatePaperEntry,
    wouldChasePrice,
} from './paper-trade';

const SOL_USD = 120;
const FEE_SOL = 0.0011;

const entryInput = {
    priceUsd: 0.001,
    positionSizeUsd: 5,
    slippageBps: 50,
    roundTripFeeSol: FEE_SOL,
};

const exitBase = {
    entryFillPriceUsd: 0.001,
    currentPriceUsd: 0.001,
    highestPriceUsd: 0.001,
    targetTakeProfitPercent: 20,
    targetStopLossPercent: 12,
    targetTrailingDistancePercent: 0.8,
    ageMinutes: 1,
    maxHoldMinutes: 240,
};

describe('simulatePaperEntry', () => {
    // A paper fill at the quoted price is a fill nobody ever gets, and the gap is widest on exactly
    // the fast-moving tokens a momentum gate selects for.
    it('pays the slippage rather than filling at the quote', () => {
        const entry = simulatePaperEntry(entryInput);
        expect(entry.fillPriceUsd).toBeCloseTo(0.001 * 1.005, 12);
        expect(entry.fillPriceUsd).toBeGreaterThan(entryInput.priceUsd);
    });

    it('buys fewer tokens than the quote would have bought', () => {
        const withSlip = simulatePaperEntry(entryInput);
        const noSlip = simulatePaperEntry({ ...entryInput, slippageBps: 0 });
        expect(withSlip.tokenAmount).toBeLessThan(noSlip.tokenAmount);
        expect(withSlip.costUsd).toBe(noSlip.costUsd);
    });

    it('charges half the round trip at entry', () => {
        expect(simulatePaperEntry(entryInput).entryFeeSol).toBeCloseTo(FEE_SOL / 2, 12);
    });

    it('returns an empty fill rather than dividing by a nonsense price', () => {
        for (const bad of [0, -1, Number.NaN]) {
            const entry = simulatePaperEntry({ ...entryInput, priceUsd: bad });
            expect(entry.tokenAmount).toBe(0);
            expect(Number.isFinite(entry.fillPriceUsd)).toBe(true);
        }
        expect(simulatePaperEntry({ ...entryInput, positionSizeUsd: 0 }).tokenAmount).toBe(0);
    });
});

describe('decidePaperExit', () => {
    it('holds while price sits between the thresholds', () => {
        expect(decidePaperExit(exitBase).shouldExit).toBe(false);
    });

    it('takes profit at the target', () => {
        const out = decidePaperExit({ ...exitBase, currentPriceUsd: 0.0012 });
        expect(out.reason).toBe('TAKE_PROFIT');
        expect(out.profitPercent).toBeCloseTo(20, 6);
    });

    it('stops out at the floor', () => {
        const out = decidePaperExit({ ...exitBase, currentPriceUsd: 0.00088 });
        expect(out.reason).toBe('STOP_LOSS');
    });

    // Evaluating take profit before stop loss would measure a different strategy than the one
    // actually running, so the order mirrors the live monitor exactly.
    it('prefers the stop over the target when a single tick clears both', () => {
        const out = decidePaperExit({
            ...exitBase,
            currentPriceUsd: 0.0005,
            targetTakeProfitPercent: -90,
        });
        expect(out.reason).toBe('STOP_LOSS');
    });

    it('calls a collapse a panic rather than an ordinary stop', () => {
        const out = decidePaperExit({ ...exitBase, currentPriceUsd: 0.0004 });
        expect(out.reason).toBe('PANIC');
    });

    it('trails from the high water mark once price has been above entry', () => {
        const out = decidePaperExit({
            ...exitBase,
            highestPriceUsd: 0.00115,
            currentPriceUsd: 0.00114,
        });
        expect(out.reason).toBe('TRAILING_STOP');
        expect(out.trailingStopPriceUsd).toBeCloseTo(0.00115 * 0.992, 12);
    });

    // A 0.8% trail on a position that never rose would fire on the first tick and record an exit
    // that the live monitor would never have taken.
    it('does not arm the trail before price has gone above entry', () => {
        const out = decidePaperExit({ ...exitBase, currentPriceUsd: 0.000999 });
        expect(out.shouldExit).toBe(false);
    });

    it('carries the high water mark forward', () => {
        const out = decidePaperExit({ ...exitBase, currentPriceUsd: 0.00105 });
        expect(out.highestPriceUsd).toBeCloseTo(0.00105, 12);
    });

    // Without this a position that reaches no threshold stays open forever and quietly poisons
    // every average computed over closed trades.
    it('closes a position that has reached nothing in time', () => {
        const out = decidePaperExit({ ...exitBase, ageMinutes: 240 });
        expect(out.reason).toBe('MAX_HOLD');
        expect(decidePaperExit({ ...exitBase, ageMinutes: 239 }).shouldExit).toBe(false);
    });

    it('never exits on a nonsense price', () => {
        expect(decidePaperExit({ ...exitBase, currentPriceUsd: 0 }).shouldExit).toBe(false);
        expect(decidePaperExit({ ...exitBase, entryFillPriceUsd: 0 }).shouldExit).toBe(false);
    });
});

describe('computePaperResult with the shared fee definition', () => {
    it('reports gross profit, leaving fees to computeNetProfitUsd', () => {
        const entry = simulatePaperEntry({ ...entryInput, slippageBps: 0 });
        const result = computePaperResult({
            entry,
            exitPriceUsd: 0.0012,
            roundTripFeeSol: FEE_SOL,
        });
        expect(result.profitUsd).toBeCloseTo(1, 6); // $5 -> $6
        expect(result.totalFeesSol).toBeCloseTo(FEE_SOL, 12);
    });

    // The whole reason fees are modelled: at the sizes this bot trades they decide the sign.
    it('turns a thin paper win into a loss once fees are applied', () => {
        const entry = simulatePaperEntry({ ...entryInput, positionSizeUsd: 2, slippageBps: 0 });
        const result = computePaperResult({
            entry,
            exitPriceUsd: 0.00102, // +2% gross
            roundTripFeeSol: FEE_SOL,
        });

        expect(result.profitUsd).toBeGreaterThan(0);
        const net = computeNetProfitUsd({
            profitUsd: result.profitUsd,
            totalFeesSol: result.totalFeesSol,
            solPriceAtEntry: SOL_USD,
        });
        expect(net).toBeLessThan(0);
    });

    // A $2 position pays 6.6% of itself in fees. Stating it as a test keeps the number honest if
    // the fee assumption is ever changed.
    it('charges 6.6% of a $2 position and 2.6% of a $5 one', () => {
        const feeUsd = FEE_SOL * SOL_USD;
        expect((feeUsd / 2) * 100).toBeCloseTo(6.6, 1);
        expect((feeUsd / 5) * 100).toBeCloseTo(2.64, 1);
    });

    it('returns zero rather than a wrong number for an unfilled entry', () => {
        const entry = simulatePaperEntry({ ...entryInput, priceUsd: 0 });
        const result = computePaperResult({
            entry,
            exitPriceUsd: 0.002,
            roundTripFeeSol: FEE_SOL,
        });
        expect(result.profitUsd).toBe(0);
    });
});

describe('wouldChasePrice', () => {
    // 5% is the live default for MAX_BUY_CHASE_PCT.
    it('refuses a price that has run further than the limit', () => {
        expect(wouldChasePrice(100, 106, 5)).toBe(true);
        expect(wouldChasePrice(100, 104.9, 5)).toBe(false);
    });

    // Exactly at the limit is allowed, matching `>` in the live gate rather than `>=`.
    it('allows a price sitting exactly on the limit', () => {
        expect(wouldChasePrice(100, 105, 5)).toBe(false);
    });

    // A price that fell is the common case on this bot's signals and must never be refused: the
    // live bot simply fills cheaper, which is the whole reason the stale snapshot was costing money.
    it('never refuses a price that moved down', () => {
        expect(wouldChasePrice(100, 64, 5)).toBe(false);
        expect(wouldChasePrice(100, 0.01, 5)).toBe(false);
    });

    // Refusing on missing data would silently stop recording signals, which is the failure that
    // left meta-trend with nothing to learn from in the first place.
    it('does not refuse when either price is missing or nonsense', () => {
        for (const [signal, quote] of [
            [0, 100],
            [100, 0],
            [-1, 100],
            [Number.NaN, 100],
            [100, Number.NaN],
        ]) {
            expect(wouldChasePrice(signal, quote, 5)).toBe(false);
        }
    });

    it('treats a negative limit as zero tolerance rather than inverting it', () => {
        expect(wouldChasePrice(100, 101, -5)).toBe(true);
        expect(wouldChasePrice(100, 100, -5)).toBe(false);
    });
});
