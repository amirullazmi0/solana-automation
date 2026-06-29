import {
    calculateCleanSwapSolAmount,
    calculateFinalBuySizeUsd,
    capSlippageBps,
    evaluateBuyRisk,
    normalizePriceImpactPct,
    resolveRiskLookbackStart,
    PriceAnomalyError,
    validateSellPrice,
} from './trade.service';
import { computeNetProfitUsd } from '../common/fee-utils';

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
        // The Jito tip is paid in a SEPARATE transaction (tx2). rawSolDeltaLamports is read
        // from the swap tx (tx1) only, so the tip is NEVER present in it and must NOT be
        // applied to the clean price math. ATA rent IS in tx1 (removed for price isolation)
        // but is a recoverable deposit, so it is NOT counted as a fee.
        it('BUY: excludes the tip from the clean amount (tip is not in tx1 raw delta)', () => {
            // tx1 delta = swap(1.0 SOL) + networkFee + rent  (no tip)
            const networkFeeLamports = 5_000;
            const rentDeltaLamports = 2_034_280;
            const jitoTipLamports = 1_000_000;
            const rawSolDeltaLamports = 1_000_000_000 + networkFeeLamports + rentDeltaLamports;

            const result = calculateCleanSwapSolAmount(
                rawSolDeltaLamports,
                networkFeeLamports,
                rentDeltaLamports,
                jitoTipLamports,
            );

            expect(result.cleanSolAmount).toBe(1); // true SOL spent on tokens (tip excluded)
            expect(result.totalFeesSol).toBe((networkFeeLamports + jitoTipLamports) / 1e9); // 0.001005, rent excluded
        });

        it('SELL: excludes the tip and the rent refund from proceeds/fees', () => {
            // tx1 delta = received(1.0 SOL) - networkFee + rentRefund  (no tip)
            const networkFeeLamports = 5_000;
            const rentDeltaLamports = 2_039_280;
            const jitoTipLamports = 1_000_000;
            const rawSolDeltaLamports = 1_000_000_000 - networkFeeLamports + rentDeltaLamports;

            const result = calculateCleanSwapSolAmount(
                rawSolDeltaLamports,
                networkFeeLamports,
                rentDeltaLamports,
                jitoTipLamports,
                'SELL',
            );

            expect(result.cleanSolAmount).toBe(1); // true SOL received (tip + rent refund excluded)
            expect(result.totalFeesSol).toBe((networkFeeLamports + jitoTipLamports) / 1e9); // 0.001005
        });

        it('SELL: adds network fee back to proceeds before subtracting rent (no Jito)', () => {
            const rawSolDeltaLamports = 999_495_000;
            const networkFeeLamports = 505_000;
            const rentDeltaLamports = 0;
            const jitoTipLamports = 0;

            const result = calculateCleanSwapSolAmount(
                rawSolDeltaLamports,
                networkFeeLamports,
                rentDeltaLamports,
                jitoTipLamports,
                'SELL',
            );

            expect(result.cleanSolAmount).toBe(1);
            expect(result.totalFeesSol).toBe(0.000505);
        });

        it('BUY no-Jito (tip=0): clean amount unchanged, fees exclude rent', () => {
            const networkFeeLamports = 5_000;
            const rentDeltaLamports = 2_034_280;
            const rawSolDeltaLamports = 1_000_000_000 + networkFeeLamports + rentDeltaLamports;

            const result = calculateCleanSwapSolAmount(
                rawSolDeltaLamports,
                networkFeeLamports,
                rentDeltaLamports,
                0,
            );

            expect(result.cleanSolAmount).toBe(1);
            expect(result.totalFeesSol).toBe(networkFeeLamports / 1e9); // 0.000005
        });

        it('returns null when fees exceed the raw SOL delta', () => {
            const result = calculateCleanSwapSolAmount(100, 50, 50, 1);
            expect(result.cleanSolAmount).toBeNull();
        });
    });

    describe('computeNetProfitUsd', () => {
        it('subtracts fees in USD using solPriceAtEntry', () => {
            // gross +$0.05, fees 0.002 SOL @ $150 = $0.30 -> net -$0.25
            expect(
                computeNetProfitUsd({ profitUsd: 0.05, totalFeesSol: 0.002, solPriceAtEntry: 150 }),
            ).toBeCloseTo(-0.25, 6);
        });
        it('falls back to gross when solPriceAtEntry is missing', () => {
            expect(
                computeNetProfitUsd({ profitUsd: 1.0, totalFeesSol: 0.002, solPriceAtEntry: 0 }),
            ).toBeCloseTo(1.0, 6);
        });
        it('a gross win that is a net loss becomes negative', () => {
            expect(
                computeNetProfitUsd({ profitUsd: 0.01, totalFeesSol: 0.002, solPriceAtEntry: 150 }),
            ).toBeLessThan(0);
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

    describe('resolveRiskLookbackStart', () => {
        it('uses the newer value between manual baseline and consecutive lookback', () => {
            const nowMs = Date.parse('2026-06-28T12:00:00Z');
            const oldBaseline = new Date('2026-06-27T00:00:00Z');

            expect(resolveRiskLookbackStart(oldBaseline, 3, nowMs)?.toISOString()).toBe(
                '2026-06-28T09:00:00.000Z',
            );
        });

        it('uses manual baseline when it is newer than the lookback window', () => {
            const nowMs = Date.parse('2026-06-28T12:00:00Z');
            const freshBaseline = new Date('2026-06-28T11:00:00Z');

            expect(resolveRiskLookbackStart(freshBaseline, 3, nowMs)?.toISOString()).toBe(
                '2026-06-28T11:00:00.000Z',
            );
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
