import { Zone } from './shved-zones';

/**
 * What price is doing relative to its bands, as one word.
 *
 * `NO_PLAN` is not a failure state. A coin with supply above and nothing below has no floor to lean
 * on, and saying so is more useful than inventing a level: the whole point of these bands is that
 * they are observed, not chosen.
 */
export type ZoneAction =
    | 'IN_BUY_ZONE'
    | 'NEAR_BUY'
    | 'WAIT'
    | 'NEAR_SELL'
    | 'IN_SELL_ZONE'
    | 'NO_PLAN';

export interface ZoneAdvice {
    action: ZoneAction;
    /** Signed percentage to the near edge of each band; negative is below price. */
    buyDistancePct?: number;
    sellDistancePct?: number;
    /** Upside to the sell band over downside to the buy band, when both exist. */
    rewardRisk?: number;
    /** True when the series is too short for the bands to mean much yet. */
    thin: boolean;
}

export interface ZoneAdviceInput {
    price: number;
    buyZone?: Zone;
    sellZone?: Zone;
    insideZone?: Zone;
    candleCount: number;
    minimumCandles: number;
}

/**
 * How close counts as "at" a band, in percent.
 *
 * Deliberately not a config knob. It is a property of how these bands are built -- the band already
 * has width, fuzzed by ATR -- so a second, independent tolerance on top of it would just be a way to
 * make the verdict say whatever the reader wanted.
 */
const NEAR_PCT = 2;

/** Below twice the minimum, the bands rest on too little history to lean on. */
export function isThin(candleCount: number, minimumCandles: number): boolean {
    return candleCount < minimumCandles * 2;
}

export function adviseOnZones(input: ZoneAdviceInput): ZoneAdvice {
    const { price, buyZone, sellZone, insideZone } = input;
    const thin = isThin(input.candleCount, input.minimumCandles);

    const buyDistancePct = buyZone ? pct(price, buyZone.high) : undefined;
    const sellDistancePct = sellZone ? pct(price, sellZone.low) : undefined;

    // Reward over risk, both to the near edge. Undefined when a side is missing, because a trade
    // with no known exit and one with no known floor are unrankable rather than merely worse.
    let rewardRisk: number | undefined;
    if (buyDistancePct !== undefined && sellDistancePct !== undefined) {
        const risk = Math.abs(buyDistancePct);
        rewardRisk = risk > 0 ? sellDistancePct / risk : undefined;
    }

    const base = { buyDistancePct, sellDistancePct, rewardRisk, thin };

    // Standing inside a band beats any distance reading, so it is checked first. Which kind of band
    // decides the whole verdict: inside demand is the entry this chart exists to find, inside supply
    // is where buying means paying the price everyone else is selling into.
    if (insideZone) {
        return {
            ...base,
            action: insideZone.type === 'SUPPORT' ? 'IN_BUY_ZONE' : 'IN_SELL_ZONE',
        };
    }

    if (!buyZone && !sellZone) return { ...base, action: 'NO_PLAN' };

    // Proximity to supply is checked before proximity to demand. Both can be true at once in a tight
    // range, and in that case the ceiling is the fact that decides whether to act.
    if (sellDistancePct !== undefined && sellDistancePct <= NEAR_PCT) {
        return { ...base, action: 'NEAR_SELL' };
    }
    if (buyDistancePct !== undefined && Math.abs(buyDistancePct) <= NEAR_PCT) {
        return { ...base, action: 'NEAR_BUY' };
    }
    if (!buyZone) return { ...base, action: 'NO_PLAN' };

    return { ...base, action: 'WAIT' };
}

function pct(price: number, target: number): number | undefined {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(target)) return undefined;
    return ((target - price) / price) * 100;
}
