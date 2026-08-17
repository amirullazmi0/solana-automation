import {
    AiExitAdvice,
    confidenceRank,
    isAdviceFresh,
    normalizeExitAdvice,
    resolveAdvisedTrailingDistance,
    shouldExitEarly,
    shouldRefreshAdvice,
} from './exit-advice';

const NOW = 1_700_000_000_000;

function advice(overrides: Partial<AiExitAdvice> = {}): AiExitAdvice {
    return {
        bias: 'HOLD',
        trailingDistancePercent: 3,
        confidenceLevel: 'high',
        reasoning: 'test',
        updatedAt: NOW,
        ...overrides,
    };
}

describe('exit-advice', () => {
    describe('normalisation', () => {
        it('falls back to the safe end when the model returns nonsense', () => {
            const result = normalizeExitAdvice({ bias: 'MOON' as never }, NOW);
            expect(result.bias).toBe('HOLD');
            expect(result.confidenceLevel).toBe('low');
        });

        it('drops a trailing distance outside the plausible band', () => {
            // A 0% trail would stop the position out on the very next tick.
            expect(normalizeExitAdvice({ trailingDistancePercent: 0 }, NOW).trailingDistancePercent)
                .toBeUndefined();
            expect(normalizeExitAdvice({ trailingDistancePercent: 900 }, NOW).trailingDistancePercent)
                .toBeUndefined();
            expect(normalizeExitAdvice({ trailingDistancePercent: 2.5 }, NOW).trailingDistancePercent)
                .toBe(2.5);
        });
    });

    describe('trailing distance is one-directional', () => {
        it('accepts a tighter trail', () => {
            expect(
                resolveAdvisedTrailingDistance(4, advice({ trailingDistancePercent: 2 }), { now: NOW }),
            ).toBe(2);
        });

        // The whole point of the design: an LLM must never be able to loosen risk.
        it('refuses a wider trail', () => {
            expect(
                resolveAdvisedTrailingDistance(3, advice({ trailingDistancePercent: 12 }), { now: NOW }),
            ).toBe(3);
        });

        it('ignores stale advice', () => {
            const stale = advice({ trailingDistancePercent: 1, updatedAt: NOW - 200_000 });
            expect(resolveAdvisedTrailingDistance(4, stale, { now: NOW })).toBe(4);
        });

        it('ignores advice below the confidence floor', () => {
            const weak = advice({ trailingDistancePercent: 1, confidenceLevel: 'low' });
            expect(resolveAdvisedTrailingDistance(4, weak, { now: NOW })).toBe(4);
        });

        it('leaves the distance untouched when there is no advice at all', () => {
            expect(resolveAdvisedTrailingDistance(4, undefined, { now: NOW })).toBe(4);
        });
    });

    describe('early exit', () => {
        const enabled = { now: NOW, allowExitNow: true };

        it('stays shut unless explicitly enabled', () => {
            expect(shouldExitEarly(advice({ bias: 'EXIT_NOW' }), { now: NOW })).toBe(false);
            expect(shouldExitEarly(advice({ bias: 'EXIT_NOW' }), enabled)).toBe(true);
        });

        it('exits only on a confident EXIT_NOW', () => {
            expect(
                shouldExitEarly(advice({ bias: 'EXIT_NOW', confidenceLevel: 'medium' }), enabled),
            ).toBe(false);
            expect(shouldExitEarly(advice({ bias: 'TIGHTEN' }), enabled)).toBe(false);
            expect(shouldExitEarly(advice({ bias: 'HOLD' }), enabled)).toBe(false);
        });

        // Guards the $Imagine case: closed seconds after entry at -2.13% on a calm token.
        it('leaves a young position alone', () => {
            const opts = { ...enabled, minHoldSeconds: 90 };
            expect(
                shouldExitEarly(advice({ bias: 'EXIT_NOW' }), { ...opts, positionAgeMs: 5_000 }),
            ).toBe(false);
            expect(
                shouldExitEarly(advice({ bias: 'EXIT_NOW' }), { ...opts, positionAgeMs: 120_000 }),
            ).toBe(true);
        });

        it('treats an unknown position age as too young to judge', () => {
            expect(
                shouldExitEarly(advice({ bias: 'EXIT_NOW' }), { ...enabled, minHoldSeconds: 90 }),
            ).toBe(false);
        });

        it('never acts on stale advice', () => {
            const stale = advice({ bias: 'EXIT_NOW', updatedAt: NOW - 200_000 });
            expect(shouldExitEarly(stale, enabled)).toBe(false);
        });

        it('does nothing when the advisor never answered', () => {
            expect(shouldExitEarly(undefined, enabled)).toBe(false);
        });
    });

    describe('refresh scheduling', () => {
        it('asks for a first opinion immediately', () => {
            expect(shouldRefreshAdvice(undefined, 20_000, NOW)).toBe(true);
        });

        it('waits out the interval before spending another call', () => {
            expect(shouldRefreshAdvice(advice(), 20_000, NOW + 5_000)).toBe(false);
            expect(shouldRefreshAdvice(advice(), 20_000, NOW + 25_000)).toBe(true);
        });
    });

    it('ranks confidence so a floor can be compared numerically', () => {
        expect(confidenceRank('high')).toBeGreaterThan(confidenceRank('medium'));
        expect(confidenceRank('medium')).toBeGreaterThan(confidenceRank('low'));
        expect(confidenceRank(undefined)).toBe(0);
    });

    it('treats freshness as a hard window', () => {
        expect(isAdviceFresh(advice(), 90_000, NOW + 89_000)).toBe(true);
        expect(isAdviceFresh(advice(), 90_000, NOW + 91_000)).toBe(false);
    });
});
