import {
    calculateCleanSwapSolAmount,
    calculateFinalBuySizeUsd,
    capSlippageBps,
    evaluateBuyRisk,
    normalizePriceImpactPct,
    PriceAnomalyError,
    validateSellPrice,
} from './trade.service';

describe('TradeService calculation helpers', () => {
    describe('normalizePriceImpactPct', () => {
        it('converts fraction-style Jupiter values to percent', () => {
            expect(normalizePriceImpactPct('0.012')).toBeCloseTo(1.2);
        });

        it('keeps percent-style values unchanged', () => {
            expect(normalizePriceImpactPct('1.2')).toBeCloseTo(1.2);
        });

        it('returns a high sentinel for invalid values', () => {
            expect(normalizePriceImpactPct('bad')).toBe(999);
        });
    });

    describe('capSlippageBps', () => {
        it('caps requested slippage by route max', () => {
            expect(capSlippageBps(500, 300)).toBe(300);
            expect(capSlippageBps(500, 150)).toBe(150);
        });

        it('keeps safe requested slippage', () => {
            expect(capSlippageBps(100, 300)).toBe(100);
        });
    });
    describe('validateSellPrice', () => {
        it.each([0.5, 1.0, 2.5, 150])('accepts matching prices at $%s', (price) => {
            expect(validateSellPrice(price, price, 'mint')).toBe(price);
        });

        it('uses Jupiter as tiebreaker for moderate deviation', () => {
            expect(validateSellPrice(2.2, 2.5, 'mint')).toBe(2.5);
        });

        it('throws for large deviation', () => {
            expect(() => validateSellPrice(2.5, 0.3, 'mint')).toThrow(PriceAnomalyError);
        });

        it('throws when both prices are invalid', () => {
            expect(() => validateSellPrice(0, null, 'mint')).toThrow(PriceAnomalyError);
        });
    });

    describe('calculateCleanSwapSolAmount', () => {
        it('removes network fee, rent, and Jito tip from raw SOL delta', () => {
            const rawSolDeltaLamports = 1_003_039_280;
            const networkFeeLamports = 5_000;
            const rentDeltaLamports = 2_034_280;
            const jitoTipLamports = 1_000_000;

            const result = calculateCleanSwapSolAmount(
                rawSolDeltaLamports,
                networkFeeLamports,
                rentDeltaLamports,
                jitoTipLamports,
            );

            expect(result.cleanSolAmount).toBe(1);
            expect(result.totalFeesSol).toBe(0.00303928);
        });

        it('returns null when fees exceed the raw SOL delta', () => {
            const result = calculateCleanSwapSolAmount(100, 50, 50, 1);
            expect(result.cleanSolAmount).toBeNull();
        });
    });

    describe('calculateFinalBuySizeUsd', () => {
        it('applies route and AI multipliers', () => {
            expect(calculateFinalBuySizeUsd(3, 0.7, 0.5)).toBeCloseTo(1.05);
            expect(calculateFinalBuySizeUsd(3, 1, 1)).toBeCloseTo(3);
        });

        it('clamps unsafe multipliers', () => {
            expect(calculateFinalBuySizeUsd(3, 0, 5)).toBeCloseTo(0.3);
        });
    });

    describe('evaluateBuyRisk', () => {
        it('allows when all guards disabled', () => {
            const res = evaluateBuyRisk(
                { dailyRealizedPnlUsd: -999, consecutiveLosses: 10, totalRealizedPnlUsd: -9999 },
                {
                    disabledUntilMs: null,
                    dailyMaxLossUsd: 0,
                    maxConsecutiveLosses: 0,
                    maxDrawdownPct: 0,
                },
                100,
                1000,
            );
            expect(res.allowed).toBe(true);
        });

        it('blocks when disabledUntil is in the future', () => {
            const res = evaluateBuyRisk(
                { dailyRealizedPnlUsd: 0, consecutiveLosses: 0, totalRealizedPnlUsd: 0 },
                {
                    disabledUntilMs: 2000,
                    dailyMaxLossUsd: 0,
                    maxConsecutiveLosses: 0,
                    maxDrawdownPct: 0,
                },
                100,
                1000,
            );
            expect(res.allowed).toBe(false);
            expect(res.reason).toBe('disabled_until');
        });

        it('blocks on daily max loss', () => {
            const res = evaluateBuyRisk(
                { dailyRealizedPnlUsd: -50, consecutiveLosses: 0, totalRealizedPnlUsd: 0 },
                {
                    disabledUntilMs: null,
                    dailyMaxLossUsd: 20,
                    maxConsecutiveLosses: 0,
                    maxDrawdownPct: 0,
                },
                100,
            );
            expect(res.allowed).toBe(false);
            expect(res.reason).toBe('daily_max_loss');
        });

        it('blocks on consecutive losses', () => {
            const res = evaluateBuyRisk(
                { dailyRealizedPnlUsd: 0, consecutiveLosses: 3, totalRealizedPnlUsd: 0 },
                {
                    disabledUntilMs: null,
                    dailyMaxLossUsd: 0,
                    maxConsecutiveLosses: 3,
                    maxDrawdownPct: 0,
                },
                100,
            );
            expect(res.allowed).toBe(false);
            expect(res.reason).toBe('max_consecutive_losses');
        });

        it('blocks on max drawdown pct', () => {
            const res = evaluateBuyRisk(
                { dailyRealizedPnlUsd: 0, consecutiveLosses: 0, totalRealizedPnlUsd: -11 },
                {
                    disabledUntilMs: null,
                    dailyMaxLossUsd: 0,
                    maxConsecutiveLosses: 0,
                    maxDrawdownPct: 10,
                },
                100,
            );
            expect(res.allowed).toBe(false);
            expect(res.reason).toBe('max_drawdown');
        });
    });
});
