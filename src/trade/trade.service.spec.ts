import {
    calculateCleanSwapSolAmount,
    PriceAnomalyError,
    validateSellPrice,
} from './trade.service';

describe('TradeService calculation helpers', () => {
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
});
