import { CandleService, pickZoneTimeframe } from './candle.service';

const MIN_BARS = 41;

describe('pickZoneTimeframe', () => {
    /**
     * The bug this exists for. Pinning the zone timeframe stopped the bands jumping whenever the
     * chart timeframe changed, but a fixed 1h default quietly replaced that with something worse:
     * 41 bars of hourly candles need a token 41 hours old, and the bot's watchlist is almost
     * entirely tokens between zero and two hours old. The bands were not rare for them, they were
     * impossible — and the page said "0 zona" forever without saying why.
     */
    it('never picks a timeframe the token is too young to fill', () => {
        for (const ageHours of [0.5, 1, 2, 5, 12, 40, 100, 500, 2000]) {
            const chosen = pickZoneTimeframe(ageHours, MIN_BARS);
            const neededHours = (chosen * MIN_BARS) / 60;
            // The smallest timeframe is allowed to exceed the age; nothing finer exists to fall
            // back to, and a noisy chart beats no chart.
            if (chosen !== 1) {
                expect({ ageHours, chosen, neededHours }).toEqual({
                    ageHours,
                    chosen,
                    neededHours: expect.any(Number),
                });
                expect(neededHours).toBeLessThanOrEqual(ageHours);
            }
        }
    });

    it('takes the largest timeframe that still fits', () => {
        // 41 bars need: 1m -> 0.7h, 5m -> 3.4h, 15m -> 10.2h, 1h -> 41h, 4h -> 164h.
        expect(pickZoneTimeframe(2, MIN_BARS)).toBe(1);
        expect(pickZoneTimeframe(4, MIN_BARS)).toBe(5);
        expect(pickZoneTimeframe(11, MIN_BARS)).toBe(15);
        expect(pickZoneTimeframe(42, MIN_BARS)).toBe(60);
        expect(pickZoneTimeframe(200, MIN_BARS)).toBe(240);
    });

    // A two-hour-old token is the common case on this bot's watchlist, so it gets its own test.
    it('gives a two-hour-old token a timeframe that can actually produce bands', () => {
        const chosen = pickZoneTimeframe(2, MIN_BARS);
        expect((chosen * MIN_BARS) / 60).toBeLessThanOrEqual(2);
    });

    // Too fine is a noisy chart; too coarse is no chart at all, so the unknown case errs fine.
    it('falls back to the smallest timeframe when age is unknown or nonsense', () => {
        for (const bad of [undefined, 0, -5, Number.NaN]) {
            expect(pickZoneTimeframe(bad as number | undefined, MIN_BARS)).toBe(1);
        }
    });

    it('only ever returns a timeframe the candle source actually serves', () => {
        const served = CandleService.TIMEFRAMES.map((t) => t.minutes);
        for (const ageHours of [0.1, 1, 3, 9, 30, 90, 400, 1200, 5000]) {
            expect(served).toContain(pickZoneTimeframe(ageHours, MIN_BARS));
        }
    });

    it('respects a custom timeframe list rather than assuming the default one', () => {
        const only = [{ minutes: 5 }, { minutes: 60 }];
        expect(pickZoneTimeframe(2, MIN_BARS, only)).toBe(5);
        expect(pickZoneTimeframe(100, MIN_BARS, only)).toBe(60);
    });
});
