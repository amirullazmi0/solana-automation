import { Zone } from './shved-zones';
import { predictNextMove } from './next-move';

function band(low: number, high: number, type: Zone['type']): Zone {
    return { type, strength: 'VERIFIED', low, high, hits: 2, turned: false, startIndex: 1 };
}

/** A flat series long enough to clear the momentum and ETA lookbacks. */
const flat = (price: number, n = 40) => Array.from({ length: n }, () => price);

/** A series that rises by `pct` per bar, so momentum and speed are both known. */
function rising(from: number, pctPerBar: number, n = 40): number[] {
    const out = [from];
    for (let i = 1; i < n; i += 1) out.push(out[i - 1] * (1 + pctPerBar / 100));
    return out;
}

const base = { candleCount: 300, minimumCandles: 41 };

describe('predictNextMove — direction', () => {
    it('calls up when momentum, flow, and the nearer band all point up', () => {
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: rising(90, 0.3),
            buyZone: band(70, 75, 'SUPPORT'),
            sellZone: band(104, 110, 'RESISTANCE'),
            buyShare1h: 65,
        });

        expect(move.direction).toBe('UP');
        expect(move.confidence).toBe('strong');
        expect(move.targetLow).toBe(104);
        expect(move.expectedMovePct).toBeCloseTo(4, 6);
    });

    it('calls down when the floor is nearer and sellers lead', () => {
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: rising(120, -0.3),
            buyZone: band(96, 98, 'SUPPORT'),
            sellZone: band(130, 140, 'RESISTANCE'),
            buyShare1h: 30,
        });

        expect(move.direction).toBe('DOWN');
        expect(move.targetHigh).toBe(98);
        expect(move.expectedMovePct).toBeCloseTo(-2, 6);
    });

    // Confidence is the count of signals that agree, never a judgement laid on top of them.
    it('reports medium when only two of three signals agree', () => {
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: rising(90, 0.3), // up
            buyZone: band(70, 75, 'SUPPORT'),
            sellZone: band(104, 110, 'RESISTANCE'), // up: sell band nearer
            buyShare1h: 30, // down
        });

        expect(move.direction).toBe('UP');
        expect(move.confidence).toBe('medium');
        expect(move.agreement).toEqual({ for: 2, total: 3 });
    });

    // A split vote has to say so rather than pick the majority and sound certain.
    it('refuses to pick a side when the signals are tied', () => {
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: rising(90, 0.3), // up
            buyShare1h: 30, // down
        });

        expect(move.direction).toBe('FLAT');
        expect(move.confidence).toBe('weak');
        expect(move.targetLow).toBeUndefined();
    });

    it('treats standing inside a demand band as its own vote', () => {
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: flat(100),
            insideZone: band(95, 105, 'SUPPORT'),
            sellZone: band(130, 140, 'RESISTANCE'),
        });
        expect(move.direction).toBe('UP');
    });

    it('treats standing inside a supply band as the opposite vote', () => {
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: flat(100),
            insideZone: band(95, 105, 'RESISTANCE'),
            buyZone: band(70, 80, 'SUPPORT'),
        });
        expect(move.direction).toBe('DOWN');
    });
});

describe('predictNextMove — time to target', () => {
    // Average absolute move per bar, not the net move: a market that swings 5% each way and ends
    // flat is fast, and a net-based figure would call it motionless and report an eternity.
    it('estimates bars from how fast price has actually been moving', () => {
        // 1% per bar, target 4% away.
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: rising(60, 1),
            buyZone: band(70, 75, 'SUPPORT'),
            sellZone: band(104, 110, 'RESISTANCE'),
            buyShare1h: 65,
        });
        expect(move.etaBars).toBe(4);
    });

    it('gives no estimate for a market that has not moved at all', () => {
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: flat(100),
            insideZone: band(95, 105, 'SUPPORT'),
            sellZone: band(130, 140, 'RESISTANCE'),
        });
        expect(move.etaBars).toBeUndefined();
    });

    it('gives no estimate without enough history to measure speed', () => {
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: [99, 100],
            buyShare1h: 70,
            sellZone: band(110, 120, 'RESISTANCE'),
            buyZone: band(80, 90, 'SUPPORT'),
        });
        expect(move.etaBars).toBeUndefined();
    });
});

describe('predictNextMove — honesty', () => {
    it('lists every signal it used, including the ones that abstained', () => {
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: flat(100),
            buyShare1h: 50,
        });
        expect(move.reasons.join(' ')).toMatch(/momentum datar/);
        expect(move.reasons.join(' ')).toMatch(/seimbang/);
        expect(move.agreement.total).toBe(0);
    });

    it('returns flat rather than a guess for a nonsense price', () => {
        const move = predictNextMove({ ...base, price: 0, closes: rising(90, 1), buyShare1h: 90 });
        expect(move.direction).toBe('FLAT');
        expect(move.agreement.total).toBe(0);
    });

    it('never throws when everything is missing', () => {
        expect(() => predictNextMove({ price: 100, closes: [], candleCount: 0, minimumCandles: 41 })).not.toThrow();
    });

    it('offers no target when there is no band on the predicted side', () => {
        const move = predictNextMove({
            ...base,
            price: 100,
            closes: rising(90, 0.3),
            buyShare1h: 70,
        });
        expect(move.direction).toBe('UP');
        expect(move.targetLow).toBeUndefined();
        expect(move.expectedMovePct).toBeUndefined();
    });
});
