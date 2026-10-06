import { Zone } from './shved-zones';
import { buildTradePlans } from './trade-plans';

function band(low: number, high: number, type: Zone['type']): Zone {
    return { type, strength: 'VERIFIED', low, high, hits: 2, turned: false, startIndex: 1 };
}

const support = (low: number, high: number) => band(low, high, 'SUPPORT');
const resistance = (low: number, high: number) => band(low, high, 'RESISTANCE');

describe('buildTradePlans', () => {
    it('pairs each buy band with the sell bands above it', () => {
        const plans = buildTradePlans(
            [support(90, 95), support(70, 75), resistance(110, 115), resistance(130, 140)],
            100,
        );

        expect(plans).toHaveLength(2);
        expect(plans[0].entryHigh).toBe(95);
        expect(plans[0].targets.map((t) => t.low)).toEqual([110, 130]);
    });

    // The worst version of the trade that still counts as working: bought at the least favourable
    // price in the zone, sold where supply first appeared.
    it('measures the headline gain from the top of the entry to the bottom of the target', () => {
        const [plan] = buildTradePlans([support(90, 100), resistance(120, 150)], 105);

        expect(plan.targets[0].gainPct).toBeCloseTo(20, 6); // 100 -> 120
        expect(plan.targets[0].bestGainPct).toBeCloseTo(66.667, 3); // 90 -> 150
    });

    // A "target" below the entry is a loss with a confident label on it.
    it('never treats a band below the entry as a target', () => {
        const plans = buildTradePlans([support(100, 110), resistance(60, 70)], 120);
        expect(plans).toEqual([]);
    });

    // A round trip costs fees before any slippage, so a sub-2% plan is a plan to pay fees.
    it('drops plans whose gain would not clear fees', () => {
        expect(buildTradePlans([support(99, 100), resistance(101, 102)], 100)).toEqual([]);
        expect(buildTradePlans([support(99, 100), resistance(105, 108)], 100)).toHaveLength(1);
    });

    it('honours a custom minimum gain', () => {
        const zones = [support(99, 100), resistance(105, 108)];
        expect(buildTradePlans(zones, 100, { minGainPct: 20 })).toEqual([]);
        expect(buildTradePlans(zones, 100, { minGainPct: 1 })).toHaveLength(1);
    });

    // An entry 40% below price with a glorious target is a bookmark, not a plan. Sorting by payoff
    // would put it above the one the reader can act on today.
    it('ranks by how reachable the entry is, not by how big the payoff looks', () => {
        const plans = buildTradePlans(
            [support(95, 98), support(50, 55), resistance(105, 110), resistance(300, 320)],
            100,
        );
        expect(plans[0].entryHigh).toBe(98);
        expect(plans[1].entryHigh).toBe(55);
    });

    it('marks the entry price is standing in right now', () => {
        const plans = buildTradePlans([support(95, 105), resistance(120, 130)], 100);
        expect(plans[0].active).toBe(true);
        expect(buildTradePlans([support(80, 90), resistance(120, 130)], 100)[0].active).toBe(false);
    });

    it('signs the distance so an entry below price reads negative', () => {
        const [plan] = buildTradePlans([support(85, 90), resistance(120, 130)], 100);
        expect(plan.distancePct).toBeCloseTo(-10, 6);
    });

    it('caps the targets per entry and the number of plans', () => {
        const zones = [
            support(90, 95), support(80, 85), support(70, 75), support(60, 65), support(50, 55),
            resistance(110, 115), resistance(130, 135), resistance(150, 155), resistance(170, 175),
        ];
        const plans = buildTradePlans(zones, 100);
        expect(plans.length).toBeLessThanOrEqual(4);
        for (const p of plans) expect(p.targets.length).toBeLessThanOrEqual(2);
    });

    it('returns nothing rather than a wrong answer for a nonsense price', () => {
        expect(buildTradePlans([support(90, 95), resistance(110, 115)], 0)).toEqual([]);
        expect(buildTradePlans([support(90, 95), resistance(110, 115)], Number.NaN)).toEqual([]);
    });

    it('ignores malformed bands instead of dividing by them', () => {
        const zones = [support(0, 0), support(95, 90), support(90, 95), resistance(110, 115)];
        const plans = buildTradePlans(zones, 100);
        expect(plans).toHaveLength(1);
        expect(plans[0].entryLow).toBe(90);
    });

    it('returns nothing when there is no sell band at all', () => {
        expect(buildTradePlans([support(90, 95), support(80, 85)], 100)).toEqual([]);
    });
});
