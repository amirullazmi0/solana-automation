/**
 * Supply and demand zones, ported from the "Shved Supply and Demand v1.5" Pine Script.
 *
 * A zone is a price band where the market previously turned. The band below the current price is
 * where buying has defended before; the band above is where selling has capped it. That is the
 * whole idea: a lower bound to buy near and an upper bound to sell near.
 *
 * Ported faithfully rather than reinterpreted. Several details look like mistakes and are not:
 *
 *   - ATR is a SIMPLE moving average of True Range over 7 bars, not the usual Wilder/RMA. The
 *     original calls MT5's `iATR`, and changing it would move every zone boundary.
 *   - Fractal detection is asymmetric: the left side rejects on `>` while the right side rejects
 *     on `>=`. That is how the source breaks ties between equal highs, and it decides which bars
 *     become zones at all.
 *   - Bars are indexed newest-first internally, matching the source's `high[k]` convention, even
 *     though the public API takes candles oldest-first like every chart library.
 *
 * The indicator was built for forex and equities: long sessions, deep books. Solana memecoins hours
 * old with thin liquidity are a different animal, and zones drawn from a short history will look
 * convincing without meaning much. That is what the minimum-bar guard below is for, and why callers
 * are expected to show the candle count next to the zones rather than hide it.
 */

export interface Candle {
    /** Unix seconds or milliseconds; only ordering matters here. */
    at: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export type ZoneType = 'SUPPORT' | 'RESISTANCE';

/**
 * How much the market has confirmed a zone.
 *
 * PROVEN and VERIFIED were defended repeatedly. UNTESTED has never been retested since it formed.
 * TURNCOAT was broken and flipped sides — old resistance acting as support, or the reverse. WEAK
 * formed without a confirming slow fractal behind it.
 */
export type ZoneStrength = 'WEAK' | 'TURNCOAT' | 'UNTESTED' | 'VERIFIED' | 'PROVEN';

export interface Zone {
    type: ZoneType;
    strength: ZoneStrength;
    high: number;
    low: number;
    /** How many times price came back and respected this band. */
    hits: number;
    /** Whether the zone flipped from resistance to support or back. */
    turned: boolean;
    /** Index into the ORIGINAL chronological candle array where the zone formed. */
    startIndex: number;
}

export interface ShvedOptions {
    fastFactor: number;
    slowFactor: number;
    /** Widens or narrows every band as a multiple of ATR. */
    fuzzFactor: number;
    zoneExtend: boolean;
    zoneMerge: boolean;
    /** How many bars back to look for zone origins. */
    backLimit: number;
}

export const DEFAULT_SHVED_OPTIONS: ShvedOptions = {
    fastFactor: 3,
    slowFactor: 6,
    fuzzFactor: 0.75,
    zoneExtend: true,
    zoneMerge: true,
    backLimit: 1000,
};

/** `P = floor(f)*2 + floor(floor(f)/2)` — 3 gives 7, 6 gives 15. */
export function calcFractalPeriod(factor: number): number {
    const b = Math.floor(Number.isFinite(factor) ? factor : 0);
    if (b < 1) return 0;
    return b * 2 + Math.floor(b / 2);
}

/**
 * The shortest history that can produce a meaningful zone: a slow fractal needs `pSlow` bars on
 * each side, and the touch scan looks eleven bars ahead.
 *
 * Returning nothing below this is the point. The same mistake was made in the meta feature, where
 * `computeAcceleration` assumed a window it had not actually observed and every label reported a
 * fabricated `22.00x` with total confidence. Zones drawn from seven candles would be that bug
 * wearing a different costume -- and on a chart they would look authoritative.
 */
export function minimumCandles(options: Partial<ShvedOptions> = {}): number {
    const slow = calcFractalPeriod(options.slowFactor ?? DEFAULT_SHVED_OPTIONS.slowFactor);
    return slow * 2 + 11;
}

function isUsable(candle: Candle | undefined): boolean {
    if (!candle) return false;
    for (const v of [candle.high, candle.low, candle.close]) {
        if (!Number.isFinite(v) || v <= 0) return false;
    }
    return candle.high >= candle.low;
}

/** True Range, with the previous close when there is one. */
function trueRange(current: Candle, previous?: Candle): number {
    const hl = current.high - current.low;
    if (!previous) return hl;
    return Math.max(hl, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close));
}

/**
 * One fractal test at `shift`, on newest-first arrays.
 *
 * The asymmetry between the two sides (`>` on the left, `>=` on the right) is copied deliberately:
 * it is how the source resolves a run of equal highs onto a single bar instead of marking all of
 * them, and loosening it would multiply the zones.
 */
function isFractal(
    highs: number[],
    lows: number[],
    total: number,
    up: boolean,
    p: number,
    shift: number,
): boolean {
    if (p <= 0) return false;
    if (shift < p || shift > total - p - 1) return false;

    for (let i = 1; i <= p; i += 1) {
        if (up) {
            if (highs[shift + i] > highs[shift] || highs[shift - i] >= highs[shift]) return false;
        } else {
            if (lows[shift + i] < lows[shift] || lows[shift - i] <= lows[shift]) return false;
        }
    }
    return true;
}

function strengthOf(hits: number, turned: boolean, weak: boolean): ZoneStrength {
    if (hits > 3) return 'PROVEN';
    if (hits > 0) return 'VERIFIED';
    if (turned) return 'TURNCOAT';
    if (!weak) return 'UNTESTED';
    return 'WEAK';
}

const STRENGTH_RANK: Record<ZoneStrength, number> = {
    WEAK: 0,
    TURNCOAT: 1,
    UNTESTED: 2,
    VERIFIED: 3,
    PROVEN: 4,
};

interface Draft {
    high: number;
    low: number;
    hits: number;
    turned: boolean;
    /** Newest-first index where the zone formed. */
    shift: number;
    strength: ZoneStrength;
    dropped: boolean;
}

/**
 * Builds the zone list for a chronological candle series.
 *
 * Returns an empty array -- never a guess -- when there is not enough history, when the options are
 * nonsensical, or when the candles are unusable. A caller that gets nothing back should say so
 * rather than draw an empty chart as if the market had no structure.
 */
export function computeShvedZones(
    candles: ReadonlyArray<Candle>,
    options: Partial<ShvedOptions> = {},
): Zone[] {
    const opts: ShvedOptions = { ...DEFAULT_SHVED_OPTIONS, ...options };

    const clean = candles.filter(isUsable);
    const pFast = calcFractalPeriod(opts.fastFactor);
    const pSlow = calcFractalPeriod(opts.slowFactor);
    if (pFast <= 0 || pSlow <= 0) return [];
    if (clean.length < minimumCandles(opts)) return [];

    const total = clean.length;
    // Newest-first, mirroring the source's `high[k]` indexing. Every loop below reads this way.
    const highs = new Array<number>(total);
    const lows = new Array<number>(total);
    const closes = new Array<number>(total);
    for (let k = 0; k < total; k += 1) {
        const c = clean[total - 1 - k];
        highs[k] = c.high;
        lows[k] = c.low;
        closes[k] = c.close;
    }

    // ATR as a simple moving average of True Range over 7 bars, computed chronologically then
    // reversed, so index 0 is the newest bar like everything else here.
    const ATR_PERIOD = 7;
    const trChrono = clean.map((c, i) => trueRange(c, i > 0 ? clean[i - 1] : undefined));
    const atr = new Array<number>(total).fill(Number.NaN);
    {
        let running = 0;
        const atrChrono = new Array<number>(total).fill(Number.NaN);
        for (let i = 0; i < total; i += 1) {
            running += trChrono[i];
            if (i >= ATR_PERIOD) running -= trChrono[i - ATR_PERIOD];
            if (i >= ATR_PERIOD - 1) atrChrono[i] = running / ATR_PERIOD;
        }
        for (let k = 0; k < total; k += 1) atr[k] = atrChrono[total - 1 - k];
    }

    // Whether a bar carries a fractal is tracked in its own boolean array, never inferred from the
    // stored price clearing some floor. The source tests `fastUp[ii] > 0.001` because it was written
    // for forex and stocks, where no real price is that small. On Solana most memecoins trade below
    // it: ABU at $0.00022 and USEFUL at $0.00013 failed that test on every single bar, so no fractal
    // was ever recognised and both reported zero zones — which reads as an honest "no setup here"
    // rather than as the scale bug it was.
    //
    // A zero sentinel is unsafe on the touch test below for the same reason: for a token priced near
    // 1e-7 the band `lows - fu` can fall below zero, and a 0 would then sit inside it and be counted
    // as a touch on a bar that has no fractal at all.
    const fastUp = new Array<number>(total).fill(0);
    const fastDown = new Array<number>(total).fill(0);
    const slowUp = new Array<number>(total).fill(0);
    const slowDown = new Array<number>(total).fill(0);
    const hasFastUp = new Array<boolean>(total).fill(false);
    const hasFastDown = new Array<boolean>(total).fill(false);
    const hasSlowUp = new Array<boolean>(total).fill(false);
    const hasSlowDown = new Array<boolean>(total).fill(false);
    for (let k = 0; k < total; k += 1) {
        if (isFractal(highs, lows, total, true, pFast, k)) {
            fastUp[k] = highs[k];
            hasFastUp[k] = true;
        }
        if (isFractal(highs, lows, total, false, pFast, k)) {
            fastDown[k] = lows[k];
            hasFastDown[k] = true;
        }
        if (isFractal(highs, lows, total, true, pSlow, k)) {
            slowUp[k] = highs[k];
            hasSlowUp[k] = true;
        }
        if (isFractal(highs, lows, total, false, pSlow, k)) {
            slowDown[k] = lows[k];
            hasSlowDown[k] = true;
        }
    }

    const drafts: Draft[] = [];
    const shiftMax = Math.min(total - 1, Math.max(0, opts.backLimit));

    for (let ii = shiftMax; ii > 5; ii -= 1) {
        const zAtr = atr[ii];
        if (!Number.isFinite(zAtr)) continue;

        const isUp = hasFastUp[ii];
        const isDown = !isUp && hasFastDown[ii];
        if (!isUp && !isDown) continue;

        const fu = (zAtr / 2) * opts.fuzzFactor;
        // No slow fractal behind this bar means the turn was never confirmed on the higher
        // timeframe, and a single break is then enough to discard the zone entirely.
        const isWeak = isUp ? !hasSlowUp[ii] : !hasSlowDown[ii];

        let hival: number;
        let loval: number;
        if (isUp) {
            hival = highs[ii] + (opts.zoneExtend ? fu : 0);
            loval = Math.max(Math.min(closes[ii], highs[ii] - fu), highs[ii] - fu * 2);
        } else {
            loval = lows[ii] - (opts.zoneExtend ? fu : 0);
            hival = Math.min(Math.max(closes[ii], lows[ii] + fu), lows[ii] + fu * 2);
        }

        // A band that reaches zero or below describes a price that cannot exist. It happens when the
        // ATR half-width exceeds the whole price, which on a microcap means the series swung more
        // than 100% inside the ATR window — measured at 2 bars out of 293 on USEFUL, and never on
        // ABU or swordcat. Such a band does not say "the level is here", it says "anywhere", so it is
        // dropped rather than clamped: clamping would keep a meaningless zone and make its distance
        // percentage look like information.
        if (!(loval > 0) || !(hival > loval)) continue;

        let turned = false;
        let hasTurned = false;
        let isBust = false;
        let bustCount = 0;
        let testCount = 0;

        for (let i = ii - 1; i >= 0; i -= 1) {
            // Once a zone has flipped sides, it is the opposite kind of fractal that tests it.
            const useUp = isUp !== turned;
            const pt = useUp ? fastUp[i] : fastDown[i];
            const hasPt = useUp ? hasFastUp[i] : hasFastDown[i];

            // Only the touch test is gated on presence. The break test below reads `highs`/`lows`
            // directly, so skipping the bar outright would lose a break and keep a dead zone alive.
            if (hasPt && pt >= loval && pt <= hival) {
                // One touch per cluster: a fractal within eleven bars of another inside the same
                // band is the same visit, not a second confirmation.
                let touchOk = true;
                for (let j = i + 1; j < i + 11 && j < total; j += 1) {
                    const hasPj = useUp ? hasFastUp[j] : hasFastDown[j];
                    const pj = useUp ? fastUp[j] : fastDown[j];
                    if (hasPj && pj >= loval && pj <= hival) {
                        touchOk = false;
                        break;
                    }
                }
                if (touchOk) {
                    bustCount = 0;
                    testCount += 1;
                }
            }

            const broken = useUp ? highs[i] > hival : lows[i] < loval;
            if (broken) {
                bustCount += 1;
                if (bustCount > 1 || isWeak) {
                    isBust = true;
                    break;
                }
                turned = !turned;
                hasTurned = true;
                testCount = 0;
            }
        }

        if (!isBust) {
            drafts.push({
                high: hival,
                low: loval,
                hits: testCount,
                turned: hasTurned,
                shift: ii,
                strength: strengthOf(testCount, hasTurned, isWeak),
                dropped: false,
            });
        }
    }

    if (opts.zoneMerge) mergeOverlapping(drafts);

    // Which side of price a zone sits on. The reference is a few bars back rather than the very
    // last close, so a single spike through a band does not reclassify it.
    const refClose = closes[Math.min(4, total - 1)];
    const zones: Zone[] = [];

    for (const d of drafts) {
        if (d.dropped) continue;

        let type: ZoneType = 'SUPPORT';
        if (d.high < refClose) {
            type = 'SUPPORT';
        } else if (d.low > refClose) {
            type = 'RESISTANCE';
        } else {
            // Price is inside the band right now, so look back for the last time it was clearly
            // on one side and keep that reading.
            for (let j = 5; j < shiftMax; j += 1) {
                if (closes[j] < d.low) {
                    type = 'RESISTANCE';
                    break;
                }
                if (closes[j] > d.high) {
                    type = 'SUPPORT';
                    break;
                }
            }
        }

        zones.push({
            type,
            strength: d.strength,
            high: d.high,
            low: d.low,
            hits: d.hits,
            turned: d.turned,
            // Back to the caller's chronological indexing.
            startIndex: total - 1 - d.shift,
        });
    }

    return zones;
}

/**
 * Collapses bands that overlap into one.
 *
 * Capped at three passes, as in the source. Without a cap a chain of touching zones can keep
 * merging into an ever-wider band that covers most of the chart and says nothing.
 */
function mergeOverlapping(drafts: Draft[]): void {
    for (let pass = 0; pass < 3; pass += 1) {
        let merged = 0;

        for (let a = 0; a < drafts.length - 1; a += 1) {
            if (drafts[a].dropped) continue;
            for (let b = a + 1; b < drafts.length; b += 1) {
                if (drafts[b].dropped) continue;

                const A = drafts[a];
                const B = drafts[b];
                const overlaps =
                    (A.high >= B.low && A.high <= B.high) ||
                    (A.low <= B.high && A.low >= B.low) ||
                    (B.high >= A.low && B.high <= A.high) ||
                    (B.low <= A.high && B.low >= A.low);
                if (!overlaps) continue;

                A.high = Math.max(A.high, B.high);
                A.low = Math.min(A.low, B.low);
                A.hits += B.hits;
                A.shift = Math.max(A.shift, B.shift);
                if (STRENGTH_RANK[B.strength] > STRENGTH_RANK[A.strength]) A.strength = B.strength;

                if (A.hits > 3) A.strength = 'PROVEN';
                // A merged zone that nothing has retested still counts as having held once,
                // because two separate formations agreeing on a price is itself evidence.
                if (A.hits === 0 && !A.turned) {
                    A.hits = 1;
                    if (STRENGTH_RANK[A.strength] < STRENGTH_RANK.VERIFIED) A.strength = 'VERIFIED';
                }
                if (!A.turned || !B.turned) A.turned = false;
                if (A.turned) A.hits = 0;

                B.dropped = true;
                merged += 1;
            }
        }

        if (merged === 0) break;
    }
}

/**
 * The band just below price and the band just above it — the practical answer to "buy where, sell
 * where".
 *
 * Chosen by proximity rather than by strength on purpose: the nearest band is the one price will
 * reach first, and a stronger band further away cannot help an entry taken now.
 */
export function resolveNearestZones(
    zones: ReadonlyArray<Zone>,
    price: number,
): { support?: Zone; resistance?: Zone; inside?: Zone } {
    if (!Number.isFinite(price) || price <= 0) return {};

    let support: Zone | undefined;
    let resistance: Zone | undefined;
    let inside: Zone | undefined;

    // Each side is strict: a buy band lies entirely below price and a sell band entirely above it.
    // The loose version tested `z.low < price` and `z.high > price`, which a band straddling price
    // satisfies on both counts -- so the same band came back as both. Real case: swordcat at
    // $0.002846 inside a $0.002643-$0.002911 band reported "buy here, sell here", with a sell
    // distance of -7.1% and a reward-to-risk of -3.1:1, which is an instruction to sell below the
    // current price.
    //
    // A band containing price is reported separately rather than dropped. It is the most useful
    // thing on the chart -- price is in the zone right now -- but it is not a target either way.
    for (const z of zones) {
        if (z.low <= price && z.high >= price) {
            if (!inside || z.high - z.low < inside.high - inside.low) inside = z;
            continue;
        }
        if (z.high < price && (!support || z.high > support.high)) support = z;
        if (z.low > price && (!resistance || z.low < resistance.low)) resistance = z;
    }

    return { support, resistance, inside };
}

/** Percentage distance from `price` to a band edge, for display. */
export function distancePct(price: number, target: number): number | undefined {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(target)) return undefined;
    return ((target - price) / price) * 100;
}
