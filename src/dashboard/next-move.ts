import { Zone } from './shved-zones';

export type MoveDirection = 'UP' | 'DOWN' | 'FLAT';
export type MoveConfidence = 'weak' | 'medium' | 'strong';

export interface NextMoveInput {
    price: number;
    /** Chronological closes, oldest first. Only the tail is read. */
    closes: number[];
    buyZone?: Zone;
    sellZone?: Zone;
    insideZone?: Zone;
    /** Buy share of 1h trade count, 0-100. */
    buyShare1h?: number;
    candleCount: number;
    minimumCandles: number;
}

export interface NextMove {
    direction: MoveDirection;
    confidence: MoveConfidence;
    /** The band price is expected to reach first, when there is one on that side. */
    targetLow?: number;
    targetHigh?: number;
    /** Signed percentage from price to the near edge of that band. */
    expectedMovePct?: number;
    /** Bars to cover that distance at the speed of the recent past. Undefined when price is still. */
    etaBars?: number;
    /** Each signal and which way it pointed, so a wrong call can be read back rather than counted. */
    reasons: string[];
    /** Signals that agreed with the call, out of those that had an opinion. */
    agreement: { for: number; total: number };
}

/** Bars compared against the bars before them. Short enough to turn, long enough not to twitch. */
const MOMENTUM_BARS = 10;

/**
 * Where price goes next, as a direction, a target band, and a time to get there.
 *
 * Built from four signals that can disagree, and the disagreement is the point: confidence here is
 * not a feeling, it is the count of signals that pointed the same way. Three out of three is strong,
 * two out of three is medium, and anything less is weak -- so a call made while the evidence is split
 * says so instead of picking a side and sounding certain.
 *
 * The signals are momentum over the last bars, where price sits between its bands, the buy share of
 * recent trades, and whether the band ahead has actually held before. None of them is predictive on
 * its own; this is a reading of the current state, not a forecast with a model behind it.
 *
 * **It has no track record.** `sol-prediction.ts` earns the right to alert by scoring itself against
 * a baseline first; nothing here has been scored against anything. Until it is, this is a structured
 * opinion, and the page must not present it as more than that.
 */
export function predictNextMove(input: NextMoveInput): NextMove {
    const { price, buyZone, sellZone, insideZone } = input;
    const reasons: string[] = [];

    if (!Number.isFinite(price) || price <= 0) {
        return { direction: 'FLAT', confidence: 'weak', reasons: ['harga tidak valid'], agreement: { for: 0, total: 0 } };
    }

    const votes: MoveDirection[] = [];

    // 1. Momentum: the last stretch against the stretch before it.
    const momentum = momentumPct(input.closes);
    if (momentum !== undefined) {
        if (momentum > 1) { votes.push('UP'); reasons.push(`momentum +${momentum.toFixed(1)}% (${MOMENTUM_BARS} bar)`); }
        else if (momentum < -1) { votes.push('DOWN'); reasons.push(`momentum ${momentum.toFixed(1)}% (${MOMENTUM_BARS} bar)`); }
        else reasons.push(`momentum datar (${momentum.toFixed(1)}%)`);
    }

    // 2. Position between the bands. Nearer the floor means the floor is what price meets next.
    const toBuy = buyZone ? Math.abs(pct(price, buyZone.high)) : undefined;
    const toSell = sellZone ? pct(price, sellZone.low) : undefined;
    if (toBuy !== undefined && toSell !== undefined) {
        if (toSell < toBuy) { votes.push('UP'); reasons.push(`zona jual lebih dekat (+${toSell.toFixed(1)}% vs -${toBuy.toFixed(1)}%)`); }
        else { votes.push('DOWN'); reasons.push(`zona beli lebih dekat (-${toBuy.toFixed(1)}% vs +${toSell.toFixed(1)}%)`); }
    }

    // 3. Who is actually trading. A band holds or breaks on flow, not on geometry.
    if (typeof input.buyShare1h === 'number') {
        if (input.buyShare1h >= 55) { votes.push('UP'); reasons.push(`${input.buyShare1h.toFixed(0)}% beli dalam 1 jam`); }
        else if (input.buyShare1h <= 45) { votes.push('DOWN'); reasons.push(`${input.buyShare1h.toFixed(0)}% beli dalam 1 jam`); }
        else reasons.push(`beli/jual seimbang (${input.buyShare1h.toFixed(0)}%)`);
    }

    // 4. Standing inside a band is itself a call: demand underfoot points up, supply overhead down.
    if (insideZone) {
        if (insideZone.type === 'SUPPORT') { votes.push('UP'); reasons.push('harga di dalam zona permintaan'); }
        else { votes.push('DOWN'); reasons.push('harga di dalam zona penawaran'); }
    }

    const up = votes.filter((v) => v === 'UP').length;
    const down = votes.filter((v) => v === 'DOWN').length;
    const direction: MoveDirection = up === down ? 'FLAT' : up > down ? 'UP' : 'DOWN';
    const agreeing = direction === 'FLAT' ? 0 : Math.max(up, down);

    // Confidence is the count of agreeing signals, never a judgement on top of them. A split vote
    // produces FLAT rather than a confident guess at the majority.
    const confidence: MoveConfidence =
        direction === 'FLAT' ? 'weak' : agreeing >= 3 ? 'strong' : agreeing === 2 ? 'medium' : 'weak';

    const target = direction === 'UP' ? sellZone : direction === 'DOWN' ? buyZone : undefined;
    const expectedMovePct = target
        ? pct(price, direction === 'UP' ? target.low : target.high)
        : undefined;

    return {
        direction,
        confidence,
        targetLow: target?.low,
        targetHigh: target?.high,
        expectedMovePct,
        etaBars: estimateEtaBars(input.closes, expectedMovePct),
        reasons,
        agreement: { for: agreeing, total: votes.length },
    };
}

/** Percentage change across the last `MOMENTUM_BARS`, or undefined when there is not enough history. */
function momentumPct(closes: number[]): number | undefined {
    if (!Array.isArray(closes) || closes.length < MOMENTUM_BARS + 1) return undefined;
    const last = closes[closes.length - 1];
    const before = closes[closes.length - 1 - MOMENTUM_BARS];
    if (!(before > 0) || !(last > 0)) return undefined;
    return ((last - before) / before) * 100;
}

/**
 * Bars to travel `movePct` at the speed of the recent past.
 *
 * Average absolute move per bar, not the net move: a market that swings 5% each way and ends flat is
 * fast, and a net-based figure would call it motionless and report an eternity.
 */
function estimateEtaBars(closes: number[], movePct?: number): number | undefined {
    if (movePct === undefined || !Array.isArray(closes) || closes.length < 11) return undefined;

    const tail = closes.slice(-21);
    let sum = 0;
    let n = 0;
    for (let i = 1; i < tail.length; i += 1) {
        if (!(tail[i - 1] > 0) || !(tail[i] > 0)) continue;
        sum += Math.abs((tail[i] - tail[i - 1]) / tail[i - 1]) * 100;
        n += 1;
    }
    if (n === 0) return undefined;

    const perBar = sum / n;
    if (perBar <= 0) return undefined;
    return Math.max(1, Math.round(Math.abs(movePct) / perBar));
}

function pct(price: number, target: number): number {
    return ((target - price) / price) * 100;
}
