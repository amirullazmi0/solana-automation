import { resolveStopProfitPercent } from './fast-stop-price';

// A token entered at 0.00002 SOL with SOL at $150, i.e. an entry price of $0.003.
const base = {
    entryPriceSol: 0.00002,
    currentSolUsd: 150,
    enabled: true,
};

describe('resolveStopProfitPercent', () => {
    it('brings the stop forward when the fresh price is already lower', () => {
        // This is the whole point. DexScreener still shows -5% because its pair data is up to
        // 30 seconds stale; Jupiter already sees -20%. Production stops configured at -8%
        // averaged a -17.1% trigger for exactly this reason.
        const result = resolveStopProfitPercent({
            ...base,
            basisProfitPercent: -5,
            fastPriceUsd: 0.0024, // 0.000016 SOL = -20%
        });

        expect(result.fastProfitPercent).toBeCloseTo(-20);
        expect(result.stopProfitPercent).toBeCloseTo(-20);
    });

    it('never holds the stop back when the fresh price looks better', () => {
        // One-directional by construction: a disagreeing fast quote must not talk the bot out of
        // an exit the existing basis already wants.
        const result = resolveStopProfitPercent({
            ...base,
            basisProfitPercent: -20,
            fastPriceUsd: 0.00285, // 0.000019 SOL = -5%
        });

        expect(result.fastProfitPercent).toBeCloseTo(-5);
        expect(result.stopProfitPercent).toBeCloseTo(-20);
    });

    it('falls back to current behaviour when no fresh quote exists', () => {
        for (const fastPriceUsd of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(
                resolveStopProfitPercent({ ...base, basisProfitPercent: -9, fastPriceUsd }),
            ).toEqual({ stopProfitPercent: -9 });
        }
    });

    it('is inert while the flag is off, and asks for nothing', () => {
        const result = resolveStopProfitPercent({
            ...base,
            enabled: false,
            basisProfitPercent: -5,
            fastPriceUsd: 0.0024,
        });
        expect(result).toEqual({ stopProfitPercent: -5 });
    });

    it('refuses to act on a broken entry price or SOL price', () => {
        // Degrading to the existing basis is safe; dividing by zero and firing a stop is not.
        for (const broken of [
            { entryPriceSol: 0 },
            { entryPriceSol: -0.00002 },
            { currentSolUsd: 0 },
            { currentSolUsd: Number.NaN },
        ]) {
            expect(
                resolveStopProfitPercent({
                    ...base,
                    ...broken,
                    basisProfitPercent: -7,
                    fastPriceUsd: 0.001,
                }),
            ).toEqual({ stopProfitPercent: -7 });
        }
    });

    it('converts through SOL so a SOL rally is not read as the token falling', () => {
        // The token is flat in SOL terms. Its USD price rose only because SOL did. Comparing the
        // USD figure against a SOL-denominated entry would report a gain here, and the mirror case
        // -- SOL falling -- would fire the stop on a position that never moved.
        const result = resolveStopProfitPercent({
            ...base,
            currentSolUsd: 300,
            basisProfitPercent: 0,
            fastPriceUsd: 0.006, // still 0.00002 SOL
        });

        expect(result.fastProfitPercent).toBeCloseTo(0);
        expect(result.stopProfitPercent).toBeCloseTo(0);
    });

    it('survives a nonsensical basis without inventing a number', () => {
        expect(
            resolveStopProfitPercent({ ...base, basisProfitPercent: Number.NaN }),
        ).toEqual({ stopProfitPercent: 0 });
    });
});
