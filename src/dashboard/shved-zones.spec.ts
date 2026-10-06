import {
    Candle,
    calcFractalPeriod,
    computeShvedZones,
    distancePct,
    minimumCandles,
    resolveNearestZones,
    Zone,
} from './shved-zones';

/** A flat series with a little noise, long enough to clear the minimum-bar guard. */
function flatSeries(n: number, price = 100): Candle[] {
    return Array.from({ length: n }, (_, i) => ({
        at: 1_700_000_000 + i * 60,
        open: price,
        high: price + 0.1,
        low: price - 0.1,
        close: price,
        volume: 1000,
    }));
}

/** Puts a single clean spike at `index`, high enough to be a fractal on both periods. */
function withSpike(candles: Candle[], index: number, peak: number): Candle[] {
    const out = candles.map((c) => ({ ...c }));
    out[index] = { ...out[index], high: peak, close: peak - 0.5, open: peak - 0.5 };
    return out;
}

describe('calcFractalPeriod', () => {
    it('reproduces the source formula', () => {
        // floor(f)*2 + floor(floor(f)/2): the two periods the whole indicator is built on.
        expect(calcFractalPeriod(3)).toBe(7);
        expect(calcFractalPeriod(6)).toBe(15);
    });

    it('refuses factors below one instead of producing a zero-width fractal', () => {
        expect(calcFractalPeriod(0)).toBe(0);
        expect(calcFractalPeriod(0.9)).toBe(0);
        expect(calcFractalPeriod(Number.NaN)).toBe(0);
    });
});

describe('computeShvedZones — the minimum-bar guard', () => {
    it('returns nothing rather than zones drawn from too little history', () => {
        // The failure this exists to prevent: the meta feature's `computeAcceleration` assumed a
        // window it had not observed and reported a fabricated 22.00x with full confidence. Zones
        // from seven candles would look just as authoritative on a chart.
        expect(minimumCandles()).toBe(41);
        for (const n of [0, 1, 7, 20, 40]) {
            expect(computeShvedZones(flatSeries(n))).toEqual([]);
        }
    });

    it('starts working once there is enough history', () => {
        expect(() => computeShvedZones(flatSeries(200))).not.toThrow();
    });

    it('returns nothing when the fractal factors are nonsense', () => {
        expect(computeShvedZones(flatSeries(200), { fastFactor: 0 })).toEqual([]);
        expect(computeShvedZones(flatSeries(200), { slowFactor: 0 })).toEqual([]);
    });
});

describe('computeShvedZones — structure', () => {
    it('finds no zones in a series with no turning points', () => {
        // A pure ramp never puts in a high surrounded by lower highs, so there is nothing to mark.
        const ramp: Candle[] = Array.from({ length: 200 }, (_, i) => ({
            at: 1_700_000_000 + i * 60,
            open: 100 + i,
            high: 100 + i + 0.5,
            low: 100 + i - 0.5,
            close: 100 + i,
            volume: 1000,
        }));
        expect(computeShvedZones(ramp)).toEqual([]);
    });

    it('marks a zone around a clean isolated spike', () => {
        const candles = withSpike(flatSeries(200), 100, 130);
        const zones = computeShvedZones(candles);

        expect(zones.length).toBeGreaterThan(0);
        // The band must bracket the spike that created it.
        const near = zones.find((z) => z.high >= 129 && z.low <= 130);
        expect(near).toBeDefined();
    });

    it('never emits a band whose low is above its high', () => {
        const candles = withSpike(withSpike(flatSeries(300), 120, 140), 200, 80);
        for (const z of computeShvedZones(candles)) {
            expect(z.high).toBeGreaterThanOrEqual(z.low);
            expect(Number.isFinite(z.high)).toBe(true);
            expect(Number.isFinite(z.low)).toBe(true);
        }
    });

    it('reports startIndex in the caller chronological frame', () => {
        const candles = withSpike(flatSeries(200), 100, 130);
        for (const z of computeShvedZones(candles)) {
            expect(z.startIndex).toBeGreaterThanOrEqual(0);
            expect(z.startIndex).toBeLessThan(candles.length);
        }
    });

    it('discards a zone that price has blown through twice', () => {
        // One break flips a zone; a second is the source's definition of busted, and the band must
        // not survive to be drawn as if it still mattered.
        const candles = flatSeries(300).map((c, i) => {
            if (i === 100) return { ...c, high: 130, close: 129 };
            if (i === 150) return { ...c, high: 150, low: 99.9, close: 149 };
            if (i === 220) return { ...c, high: 160, low: 99.9, close: 159 };
            return c;
        });
        const zones = computeShvedZones(candles);
        expect(zones.every((z) => !(z.high >= 129.5 && z.high <= 131))).toBe(true);
    });

    it('survives unusable candles without throwing', () => {
        const dirty = [
            ...flatSeries(200),
            { at: 1, open: 0, high: 0, low: 0, close: 0, volume: 0 },
            { at: 2, open: 1, high: Number.NaN, low: 1, close: 1, volume: 0 },
            { at: 3, open: 1, high: 1, low: 5, close: 1, volume: 0 },
            { at: 4, open: -1, high: -1, low: -2, close: -1, volume: 0 },
        ];
        expect(() => computeShvedZones(dirty)).not.toThrow();
    });

    it('honours backLimit without breaking', () => {
        const candles = withSpike(flatSeries(400), 300, 150);
        expect(() => computeShvedZones(candles, { backLimit: 50 })).not.toThrow();
    });
});

describe('computeShvedZones — scale invariance', () => {
    /**
     * Multiplies every price by `k`, leaving the shape of the series untouched.
     *
     * Multiplicative on purpose: the other helpers here add fixed offsets like `+0.1`, which stop
     * being small relative to the price once the price is 0.0001, so they cannot express "the same
     * chart at a different scale".
     */
    function rescale(candles: Candle[], k: number): Candle[] {
        return candles.map((c) => ({
            ...c,
            open: c.open * k,
            high: c.high * k,
            low: c.low * k,
            close: c.close * k,
        }));
    }

    /** A shape with real turning points, so there is something to be scale-invariant about. */
    function wavySeries(n: number, price = 100): Candle[] {
        return Array.from({ length: n }, (_, i) => {
            const mid = price * (1 + 0.08 * Math.sin(i / 7) + 0.03 * Math.sin(i / 2.3));
            return {
                at: 1_700_000_000 + i * 60,
                open: mid,
                high: mid * 1.004,
                low: mid * 0.996,
                close: mid,
                volume: 1000,
            };
        });
    }

    // The regression this file exists for. The source tests `fastUp[ii] > 0.001` to decide whether a
    // bar carries a fractal, which silently means "no fractals at all" for any token trading below
    // that price. Real cost: ABU at $0.00022 and USEFUL at $0.00013 both returned zero zones from a
    // full 300 candles, and zero zones reads as a verdict about the market rather than as a bug.
    // Most Solana memecoins live in exactly that range, so this covered the majority of the use case.
    it('finds the same zones on the same chart at memecoin prices', () => {
        const base = wavySeries(200, 100);
        const expected = computeShvedZones(base).length;
        expect(expected).toBeGreaterThan(0);

        for (const k of [1e-2, 1e-4, 1e-6, 1e-8]) {
            expect(computeShvedZones(rescale(base, k)).length).toBe(expected);
        }
    });

    it('scales the band edges by the same factor rather than shifting them', () => {
        const base = wavySeries(200, 100);
        const k = 1e-6;
        const big = computeShvedZones(base);
        const small = computeShvedZones(rescale(base, k));

        expect(small).toHaveLength(big.length);
        big.forEach((z, i) => {
            expect(small[i].low / k).toBeCloseTo(z.low, 6);
            expect(small[i].high / k).toBeCloseTo(z.high, 6);
            expect(small[i].hits).toBe(z.hits);
            expect(small[i].strength).toBe(z.strength);
            expect(small[i].type).toBe(z.type);
        });
    });

    // A zero means "no fractal here". Once the band itself can straddle zero — which it can when the
    // price is near 1e-7 and volatility is high — that zero falls inside the band and is counted as a
    // visit, inflating `hits` and promoting a band to PROVEN on bars that never touched it.
    it('does not count absent fractals as touches when a band straddles zero', () => {
        const wild = wavySeries(200, 1e-7).map((c, i) => ({
            ...c,
            low: i % 9 === 0 ? c.low * 0.2 : c.low,
            high: i % 5 === 0 ? c.high * 3 : c.high,
        }));
        for (const z of computeShvedZones(wild)) {
            expect(z.low).toBeGreaterThan(0);
        }
    });
});

describe('resolveNearestZones', () => {
    const zone = (low: number, high: number) =>
        ({
            type: high > 100 ? 'RESISTANCE' : 'SUPPORT',
            strength: 'VERIFIED',
            low,
            high,
            hits: 2,
            turned: false,
            startIndex: 0,
        }) as const;

    it('picks the closest band on each side, which is the one price reaches first', () => {
        const zones = [zone(80, 85), zone(90, 95), zone(105, 110), zone(130, 140)];
        const { support, resistance } = resolveNearestZones(zones, 100);

        expect(support?.high).toBe(95);
        expect(resistance?.low).toBe(105);
    });

    it('prefers proximity over strength', () => {
        // A stronger band further away cannot help an entry taken now.
        const weakClose = { ...zone(95, 98), strength: 'WEAK' as const };
        const provenFar = { ...zone(70, 75), strength: 'PROVEN' as const };
        expect(resolveNearestZones([provenFar, weakClose], 100).support?.high).toBe(98);
    });

    it('returns an empty answer rather than a wrong one for a bad price', () => {
        const zones = [zone(80, 85)];
        expect(resolveNearestZones(zones, 0)).toEqual({});
        expect(resolveNearestZones(zones, Number.NaN)).toEqual({});
    });

    it('omits a side that has no band at all', () => {
        const { support, resistance } = resolveNearestZones([zone(80, 85)], 100);
        expect(support).toBeDefined();
        expect(resistance).toBeUndefined();
    });

    // The regression from a live run: swordcat at $0.002846 sat inside a $0.002643-$0.002911 band,
    // and the loose test (`z.low < price` and `z.high > price`) is satisfied on both counts by a band
    // that straddles price. The report read "buy $0.002643-$0.002911, sell $0.002643-$0.002911" with
    // a sell distance of -7.1% and a reward-to-risk of -3.1:1 -- an instruction to sell below the
    // current price, printed with the same confidence as a real setup.
    it('never returns one band as both the buy and the sell side', () => {
        const straddling: Zone = {
            type: 'SUPPORT',
            strength: 'VERIFIED',
            low: 90,
            high: 110,
            hits: 2,
            turned: false,
            startIndex: 10,
        };
        const result = resolveNearestZones([straddling], 100);

        expect(result.support).toBeUndefined();
        expect(result.resistance).toBeUndefined();
        expect(result.inside).toBe(straddling);
    });

    it('reports a straddling band as inside while still finding the bands beyond it', () => {
        const band = (low: number, high: number): Zone => ({
            type: low > 100 ? 'RESISTANCE' : 'SUPPORT',
            strength: 'VERIFIED',
            low,
            high,
            hits: 1,
            turned: false,
            startIndex: 5,
        });
        const result = resolveNearestZones([band(95, 105), band(70, 80), band(130, 140)], 100);

        expect(result.inside).toEqual(band(95, 105));
        expect(result.support?.high).toBe(80);
        expect(result.resistance?.low).toBe(130);
    });

    // With strict sides the signs can no longer disagree with the labels, which is what let a
    // "+-7.1%" reach the report. Buy is at or below price, sell at or above it, always.
    it('keeps the buy side below price and the sell side above it', () => {
        const band = (low: number, high: number): Zone => ({
            type: 'SUPPORT',
            strength: 'WEAK',
            low,
            high,
            hits: 0,
            turned: false,
            startIndex: 1,
        });
        const price = 100;
        const { support, resistance } = resolveNearestZones(
            [band(60, 70), band(85, 95), band(105, 115), band(140, 150)],
            price,
        );

        expect(distancePct(price, support!.high)).toBeLessThanOrEqual(0);
        expect(distancePct(price, resistance!.low)).toBeGreaterThanOrEqual(0);
    });

});

describe('distancePct', () => {
    it('signs the distance so below reads negative and above positive', () => {
        expect(distancePct(100, 95)).toBeCloseTo(-5);
        expect(distancePct(100, 110)).toBeCloseTo(10);
    });

    it('declines to divide by a nonsense price', () => {
        expect(distancePct(0, 10)).toBeUndefined();
        expect(distancePct(Number.NaN, 10)).toBeUndefined();
    });
});
