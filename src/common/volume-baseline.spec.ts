import { MAX_BUCKETS, averageVolume5m, elapsedFiveMinuteBuckets } from './volume-baseline';

const MINUTE = 60_000;

/** The two metrics the baseline feeds, reproduced so the degeneracy can be asserted directly. */
function surge(volume5m: number, volume1h: number, ageMs?: number): number {
    const avg = averageVolume5m(volume1h, ageMs);
    return avg > 0 ? volume5m / avg : 0;
}
function zScore(volume5m: number, volume1h: number, ageMs?: number): number {
    const avg = averageVolume5m(volume1h, ageMs);
    return avg > 0 ? (volume5m - avg) / (avg * 0.5 || 1) : 0;
}

describe('volume-baseline', () => {
    describe('elapsedFiveMinuteBuckets', () => {
        it('scales with the history that exists', () => {
            expect(elapsedFiveMinuteBuckets(20 * MINUTE)).toBe(4);
            expect(elapsedFiveMinuteBuckets(30 * MINUTE)).toBe(6);
        });

        it('never drops below one bucket', () => {
            expect(elapsedFiveMinuteBuckets(3 * MINUTE)).toBe(1);
            expect(elapsedFiveMinuteBuckets(1000)).toBe(1);
        });

        it('caps at one hour of buckets', () => {
            expect(elapsedFiveMinuteBuckets(60 * MINUTE)).toBe(MAX_BUCKETS);
            expect(elapsedFiveMinuteBuckets(48 * 60 * MINUTE)).toBe(MAX_BUCKETS);
        });

        // An absent timestamp must not silently tighten a gate.
        it('treats an unknown age as a full hour', () => {
            expect(elapsedFiveMinuteBuckets(undefined)).toBe(MAX_BUCKETS);
            expect(elapsedFiveMinuteBuckets(Number.NaN)).toBe(MAX_BUCKETS);
            expect(elapsedFiveMinuteBuckets(0)).toBe(MAX_BUCKETS);
            expect(elapsedFiveMinuteBuckets(-5)).toBe(MAX_BUCKETS);
        });
    });

    describe('the degeneracy this module exists to remove', () => {
        // Six different tokens in one production alert batch all reported exactly
        // Surge 12.00x / Z 22.00. On a token younger than an hour, volume1h IS volume5m, so the
        // volume cancels out and both metrics collapse to a constant.
        const freshVolumes = [1_000, 5_000, 250_000];

        it('collapsed to the same constant for every volume under the old baseline', () => {
            for (const v of freshVolumes) {
                // The old formula, reproduced: always 12 buckets regardless of age.
                const oldAvg = v / 12;
                expect(v / oldAvg).toBeCloseTo(12, 10);
                expect((v - oldAvg) / (oldAvg * 0.5)).toBeCloseTo(22, 10);
            }
        });

        it('no longer collapses once the baseline follows real elapsed time', () => {
            const age = 10 * MINUTE; // 2 buckets
            for (const v of freshVolumes) {
                // All of the hour's volume arrived in the last 5 minutes of a 10-minute-old token.
                expect(surge(v, v, age)).toBeCloseTo(2, 10);
                expect(zScore(v, v, age)).toBeCloseTo(2, 10);
            }
        });

        it('reports no acceleration when volume is evenly spread', () => {
            const age = 20 * MINUTE; // 4 buckets
            const volume1h = 4_000;
            expect(surge(volume1h / 4, volume1h, age)).toBeCloseTo(1, 10);
        });

        it('still detects a genuine burst', () => {
            const age = 20 * MINUTE; // 4 buckets
            const volume1h = 4_000;
            // Half the hour's volume landed in the last five minutes.
            expect(surge(volume1h / 2, volume1h, age)).toBeCloseTo(2, 10);
        });

        it('cannot claim acceleration with less than one bucket of history', () => {
            expect(surge(900, 1_000, 3 * MINUTE)).toBeLessThanOrEqual(1);
        });
    });

    describe('mature tokens are untouched', () => {
        // The whole point of clamping at 12: anything with a real hour behind it must behave
        // byte-for-byte as before, so this change cannot alter established-token decisions.
        it('matches the old formula exactly at one hour and beyond', () => {
            for (const age of [60 * MINUTE, 6 * 60 * MINUTE, 72 * 60 * MINUTE]) {
                expect(averageVolume5m(12_000, age)).toBe(12_000 / 12);
            }
            expect(averageVolume5m(12_000, undefined)).toBe(12_000 / 12);
        });
    });

    describe('averageVolume5m guards', () => {
        it('returns zero for absent or nonsensical volume', () => {
            expect(averageVolume5m(0, 20 * MINUTE)).toBe(0);
            expect(averageVolume5m(-100, 20 * MINUTE)).toBe(0);
            expect(averageVolume5m(Number.NaN, 20 * MINUTE)).toBe(0);
        });
    });
});
