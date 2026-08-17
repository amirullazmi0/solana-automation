import { buyShare, failsBuyShare, formatBuyShare } from './flow-pressure';

describe('flow-pressure', () => {
    describe('buyShare', () => {
        it('measures the buy side of total flow', () => {
            expect(buyShare({ buys: 60, sells: 40 })).toBeCloseTo(0.6, 10);
            expect(buyShare({ buys: 1, sells: 1 })).toBeCloseTo(0.5, 10);
        });

        // No hourly history is not the same as zero buying interest.
        it('reports no data rather than a zero share', () => {
            expect(buyShare({ buys: 0, sells: 0 })).toBeNull();
        });

        it('treats a one-sided market as fully dominant', () => {
            expect(buyShare({ buys: 5, sells: 0 })).toBe(1);
            expect(buyShare({ buys: 0, sells: 5 })).toBe(0);
        });

        it('coerces junk inputs instead of returning NaN', () => {
            expect(buyShare({ buys: Number.NaN, sells: 10 })).toBe(0);
            expect(buyShare({ buys: -5, sells: -5 })).toBeNull();
        });
    });

    describe('failsBuyShare', () => {
        // The token that prompted this gate: 4,394 buys against 4,504 sells over 24h.
        it('rejects the screenshot token at a 60% threshold', () => {
            const counts = { buys: 4394, sells: 4504 };
            expect(buyShare(counts)).toBeCloseTo(0.4938, 4);
            expect(failsBuyShare(counts, 0.6)).toBe(true);
        });

        it('passes exactly at the threshold', () => {
            expect(failsBuyShare({ buys: 60, sells: 40 }, 0.6)).toBe(false);
            expect(failsBuyShare({ buys: 59, sells: 41 }, 0.6)).toBe(true);
        });

        // The single most important invariant: a young token must not be blocked for lacking
        // an hour of history, or the MICIN route stops trading entirely.
        it('never blocks when there is no data', () => {
            expect(failsBuyShare({ buys: 0, sells: 0 }, 0.6)).toBe(false);
        });

        it('never blocks a market with no sellers', () => {
            expect(failsBuyShare({ buys: 12, sells: 0 }, 0.6)).toBe(false);
        });

        it('is switched off by a zero or invalid threshold', () => {
            const bearish = { buys: 1, sells: 99 };
            expect(failsBuyShare(bearish, 0)).toBe(false);
            expect(failsBuyShare(bearish, Number.NaN)).toBe(false);
            expect(failsBuyShare(bearish, 0.6)).toBe(true);
        });
    });

    it('formats shares for logs, including the no-data case', () => {
        expect(formatBuyShare(0.4938)).toBe('49.4%');
        expect(formatBuyShare(null)).toBe('n/a');
    });
});
