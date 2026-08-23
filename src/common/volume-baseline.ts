/**
 * Baseline volume per 5 menit untuk menghitung volumeSurge dan zScore.
 *
 * The old baseline was `volume1h / 12`, which silently assumes the token has a full hour of
 * history. For anything younger, DexScreener's hourly figure IS the five-minute figure, so the
 * volume cancels out of both metrics entirely:
 *
 *     volumeSurge = v / (v/12)          = 12.00   for any v
 *     zScore      = (v - v/12) / (v/24) = 22.00   for any v
 *
 * Verified against $1,000, $5,000 and $250,000 — identical every time. Six different tokens in one
 * production alert batch all reported exactly `Surge: 12.00x, Z: 22.00`. Those are the arithmetic
 * maxima, not measurements: on a fresh token the pair only ever said "younger than five minutes".
 *
 * That also explains why neither metric separated winners from losers across the 15 closed trades
 * carrying netProfitUsd — volumeSurge averaged 4.36 for wins against 4.62 for losses, zScore 6.73
 * against 7.24. They were never measuring acceleration on the population this bot actually buys.
 *
 * The fix is to divide by the number of five-minute buckets that have genuinely elapsed.
 */

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_BUCKET = 5;
export const MAX_BUCKETS = 12; // One hour, the span DexScreener's h1 figure covers.

/**
 * How many 5-minute buckets of history the token actually has, clamped to 1..12.
 *
 * An unknown age returns the full 12 so behaviour is identical to the previous formula — an
 * absent timestamp must not silently tighten a gate.
 */
export function elapsedFiveMinuteBuckets(tokenAgeMs: number | undefined): number {
    const ageMs = Number(tokenAgeMs);
    if (!Number.isFinite(ageMs) || ageMs <= 0) return MAX_BUCKETS;

    const buckets = ageMs / MS_PER_MINUTE / MINUTES_PER_BUCKET;
    if (!Number.isFinite(buckets)) return MAX_BUCKETS;
    return Math.min(MAX_BUCKETS, Math.max(1, buckets));
}

/**
 * Average 5-minute volume, scaled to the history that exists.
 *
 *   - Token >= 1 hour old: 12 buckets, byte-for-byte the old behaviour.
 *   - Token 20 minutes old: 4 buckets. Evenly spread volume now yields surge 1.0 rather than a
 *     phantom 12.0, and a genuine burst in the last 5 minutes still shows up as surge 2.0.
 *   - Token 3 minutes old: 1 bucket, so surge cannot exceed 1. Honest: with less than one bucket
 *     of history there is no acceleration to measure yet.
 */
export function averageVolume5m(volume1hUsd: number, tokenAgeMs: number | undefined): number {
    const volume = Number(volume1hUsd);
    if (!Number.isFinite(volume) || volume <= 0) return 0;
    return volume / elapsedFiveMinuteBuckets(tokenAgeMs);
}
