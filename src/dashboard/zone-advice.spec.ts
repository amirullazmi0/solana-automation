import { Zone } from './shved-zones';
import { adviseOnZones, isThin } from './zone-advice';

function band(low: number, high: number, type: Zone['type'] = 'SUPPORT'): Zone {
    return { type, strength: 'VERIFIED', low, high, hits: 1, turned: false, startIndex: 3 };
}

const base = { candleCount: 300, minimumCandles: 41 };

describe('adviseOnZones', () => {
    it('calls price inside a demand band the entry, not a distance', () => {
        const advice = adviseOnZones({ ...base, price: 100, insideZone: band(95, 105) });
        expect(advice.action).toBe('IN_BUY_ZONE');
    });

    // Inside supply is the opposite of an entry: it is where buying means paying the price everyone
    // else is selling into. Treating "inside a band" as uniformly good would invert that.
    it('calls price inside a supply band a warning, not an entry', () => {
        const advice = adviseOnZones({
            ...base,
            price: 100,
            insideZone: band(95, 105, 'RESISTANCE'),
        });
        expect(advice.action).toBe('IN_SELL_ZONE');
    });

    it('flags proximity to the buy band', () => {
        const advice = adviseOnZones({ ...base, price: 100, buyZone: band(96, 99) });
        expect(advice.action).toBe('NEAR_BUY');
        expect(advice.buyDistancePct).toBeCloseTo(-1, 6);
    });

    it('tells you to wait while the buy band is still far below', () => {
        const advice = adviseOnZones({ ...base, price: 100, buyZone: band(70, 80) });
        expect(advice.action).toBe('WAIT');
        expect(advice.buyDistancePct).toBeCloseTo(-20, 6);
    });

    // Both can be true in a tight range. The ceiling is what decides whether to act, so it wins.
    it('prefers the ceiling when price is near both bands at once', () => {
        const advice = adviseOnZones({
            ...base,
            price: 100,
            buyZone: band(97, 99),
            sellZone: band(101, 105, 'RESISTANCE'),
        });
        expect(advice.action).toBe('NEAR_SELL');
    });

    it('reports no plan when there is no floor to lean on', () => {
        const advice = adviseOnZones({
            ...base,
            price: 100,
            sellZone: band(130, 140, 'RESISTANCE'),
        });
        expect(advice.action).toBe('NO_PLAN');
        expect(advice.rewardRisk).toBeUndefined();
    });

    it('reports no plan when there are no bands at all', () => {
        expect(adviseOnZones({ ...base, price: 100 }).action).toBe('NO_PLAN');
    });

    it('computes reward over risk from the near edges', () => {
        const advice = adviseOnZones({
            ...base,
            price: 100,
            buyZone: band(88, 90),
            sellZone: band(130, 140, 'RESISTANCE'),
        });
        // 10% down to the buy edge, 30% up to the sell edge.
        expect(advice.buyDistancePct).toBeCloseTo(-10, 6);
        expect(advice.sellDistancePct).toBeCloseTo(30, 6);
        expect(advice.rewardRisk).toBeCloseTo(3, 6);
    });

    // A band drawn from 45 bars looks exactly as authoritative as one drawn from a week of history.
    // The verdict has to carry that difference or it is just confidence with no evidence behind it.
    it('marks a verdict built on thin history', () => {
        const thin = adviseOnZones({
            price: 100,
            buyZone: band(96, 99),
            candleCount: 50,
            minimumCandles: 41,
        });
        expect(thin.thin).toBe(true);
        expect(adviseOnZones({ ...base, price: 100, buyZone: band(96, 99) }).thin).toBe(false);
    });

    it('never divides by a nonsense price', () => {
        const advice = adviseOnZones({ ...base, price: 0, buyZone: band(96, 99) });
        expect(advice.buyDistancePct).toBeUndefined();
        expect(advice.rewardRisk).toBeUndefined();
    });
});

describe('isThin', () => {
    it('draws the line at twice the minimum', () => {
        expect(isThin(81, 41)).toBe(true);
        expect(isThin(82, 41)).toBe(false);
    });
});
