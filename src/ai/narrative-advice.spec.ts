import {
    NarrativeAdvice,
    isNarrativeFresh,
    narrativeConfidenceRank,
    normalizeNarrativeAdvice,
    shouldRefreshNarrative,
    shouldRejectOnNarrative,
    stripJsonFence,
} from './narrative-advice';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function advice(overrides: Partial<NarrativeAdvice> = {}): NarrativeAdvice {
    return {
        verdict: 'WEAK',
        confidenceLevel: 'high',
        reasoning: 'test',
        evaluatedAt: NOW,
        ...overrides,
    };
}

describe('narrative-advice', () => {
    describe('normalisation', () => {
        // A malformed response must never become the blocking answer.
        it('falls back to the inert verdict on junk', () => {
            const result = normalizeNarrativeAdvice({ verdict: 'MOON' as never }, NOW);
            expect(result.verdict).toBe('NEUTRAL');
            expect(result.confidenceLevel).toBe('low');
        });

        it('handles a null response without throwing', () => {
            expect(normalizeNarrativeAdvice(null, NOW).verdict).toBe('NEUTRAL');
        });

        it('keeps a well-formed verdict', () => {
            const result = normalizeNarrativeAdvice(
                { verdict: 'WEAK', confidenceLevel: 'high', reasoning: 'template spam' },
                NOW,
            );
            expect(result).toEqual({
                verdict: 'WEAK',
                confidenceLevel: 'high',
                reasoning: 'template spam',
                evaluatedAt: NOW,
            });
        });
    });

    describe('the gate is one-directional', () => {
        const enabled = { enabled: true, now: NOW };

        it('rejects only a confident WEAK verdict', () => {
            expect(shouldRejectOnNarrative(advice(), enabled)).toBe(true);
            expect(
                shouldRejectOnNarrative(advice({ confidenceLevel: 'medium' }), enabled),
            ).toBe(false);
        });

        // The core invariant: the model can subtract candidates, never add or ease one.
        it('never lets a positive verdict influence anything', () => {
            expect(shouldRejectOnNarrative(advice({ verdict: 'STRONG' }), enabled)).toBe(false);
            expect(shouldRejectOnNarrative(advice({ verdict: 'NEUTRAL' }), enabled)).toBe(false);
        });

        it('stays shut unless explicitly enabled', () => {
            expect(shouldRejectOnNarrative(advice(), { now: NOW })).toBe(false);
            expect(shouldRejectOnNarrative(advice(), { enabled: false, now: NOW })).toBe(false);
        });

        it('ignores a stale verdict', () => {
            const stale = advice({ evaluatedAt: NOW - 48 * HOUR });
            expect(shouldRejectOnNarrative(stale, { ...enabled, maxAgeMs: 24 * HOUR })).toBe(false);
        });

        // A cold cache must let the token through, not block it.
        it('does not block when the advisor never answered', () => {
            expect(shouldRejectOnNarrative(undefined, enabled)).toBe(false);
        });

        it('honours a lowered confidence floor', () => {
            expect(
                shouldRejectOnNarrative(advice({ confidenceLevel: 'medium' }), {
                    ...enabled,
                    minConfidence: 'medium',
                }),
            ).toBe(true);
        });
    });

    describe('refresh scheduling', () => {
        // Without this the ~1s re-analysis loop would fire dozens of calls for one mint.
        it('asks once, then not again inside the TTL', () => {
            expect(shouldRefreshNarrative(undefined, 24 * HOUR, NOW)).toBe(true);
            expect(shouldRefreshNarrative(advice(), 24 * HOUR, NOW + 60_000)).toBe(false);
            expect(shouldRefreshNarrative(advice(), 24 * HOUR, NOW + 25 * HOUR)).toBe(true);
        });
    });

    describe('freshness window', () => {
        it('treats the TTL as a hard edge', () => {
            expect(isNarrativeFresh(advice(), 24 * HOUR, NOW + 23 * HOUR)).toBe(true);
            expect(isNarrativeFresh(advice(), 24 * HOUR, NOW + 25 * HOUR)).toBe(false);
        });
    });

    describe('stripJsonFence', () => {
        // The model id is an operator-facing knob, so the parser cannot assume one model's
        // formatting. A fenced response used to throw and degrade silently to the fallback.
        it('unwraps a fenced response', () => {
            expect(stripJsonFence('```json\n{"verdict":"WEAK"}\n```')).toBe('{"verdict":"WEAK"}');
            expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
        });

        it('leaves a bare response untouched', () => {
            expect(stripJsonFence('{"verdict":"WEAK"}')).toBe('{"verdict":"WEAK"}');
            expect(stripJsonFence('  {"a":1}  ')).toBe('{"a":1}');
        });

        it('survives empty input', () => {
            expect(stripJsonFence('')).toBe('');
        });

        it('produces parseable output in both shapes', () => {
            for (const raw of ['```json\n{"verdict":"STRONG"}\n```', '{"verdict":"STRONG"}']) {
                expect(JSON.parse(stripJsonFence(raw))).toEqual({ verdict: 'STRONG' });
            }
        });
    });

    it('ranks confidence so a floor can be compared numerically', () => {
        expect(narrativeConfidenceRank('high')).toBeGreaterThan(narrativeConfidenceRank('medium'));
        expect(narrativeConfidenceRank(undefined)).toBe(0);
    });
});
