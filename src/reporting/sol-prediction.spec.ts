import {
    AccuracySummary,
    ResolvedPrediction,
    meetsMinimumConfidence,
    predictSolDirection,
    resolveActualDirection,
    scorePrediction,
    shouldStartAlerting,
    summariseAccuracy,
} from './sol-prediction';

describe('predictSolDirection', () => {
    it('refuses to predict without the backbone feature', () => {
        // The mistake this guards against is the meta feature's `22.00x` bug: assuming a window
        // that has not been observed yet and reporting a fabricated number with full conviction.
        // A predictor with a three-minute buffer must say nothing, not guess quietly.
        expect(predictSolDirection({})).toBeUndefined();
        expect(predictSolDirection({ solChange5mPct: -3, memeBreadthPct: -20 })).toBeUndefined();
        expect(predictSolDirection({ solChange15mPct: Number.NaN })).toBeUndefined();
    });

    it('calls DOWN when SOL and the memecoin market both sag', () => {
        const result = predictSolDirection({
            solChange5mPct: -0.9,
            solChange15mPct: -2.2,
            solChange60mPct: -4.5,
            memeBreadthPct: -12,
            memeVolumeAccel: 0.5,
            boostShare: 0.05,
        });

        expect(result?.direction).toBe('DOWN');
        expect(result?.score).toBeLessThan(0);
        expect(result?.confidence).toBe('strong');
    });

    it('calls UP on the mirror case', () => {
        const result = predictSolDirection({
            solChange5mPct: 0.9,
            solChange15mPct: 2.2,
            solChange60mPct: 4.5,
            memeBreadthPct: 12,
            memeVolumeAccel: 2,
            boostShare: 0.3,
        });

        expect(result?.direction).toBe('UP');
        expect(result?.score).toBeGreaterThan(0);
    });

    it('answers FLAT rather than rounding a nothing-signal into a direction', () => {
        const result = predictSolDirection({
            solChange15mPct: 0,
            memeBreadthPct: 0,
            memeVolumeAccel: 1,
            boostShare: 0.15,
        });

        expect(result?.direction).toBe('FLAT');
        expect(result?.score).toBeCloseTo(0);
        expect(result?.confidence).toBe('weak');
    });

    it('lets volatility cut confidence without ever choosing a side', () => {
        const base = {
            solChange5mPct: 1,
            solChange15mPct: 2.5,
            solChange60mPct: 5,
            memeBreadthPct: 11,
        };
        const calm = predictSolDirection(base)!;
        const wild = predictSolDirection({ ...base, solVolatilityPct: 3 })!;

        // Same side, less conviction. Volatility must never flip the call.
        expect(wild.direction).toBe(calm.direction);
        expect(Math.abs(wild.score)).toBeLessThan(Math.abs(calm.score));
    });

    it('saturates so one absurd reading cannot dominate the blend', () => {
        const sane = predictSolDirection({ solChange15mPct: 2, memeBreadthPct: 10 })!;
        const absurd = predictSolDirection({ solChange15mPct: 2, memeBreadthPct: 100000 })!;
        expect(absurd.score).toBeLessThanOrEqual(1);
        expect(absurd.score).toBeGreaterThan(sane.score - 1);
    });

    it('survives nonsense inputs without throwing', () => {
        for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
            expect(() =>
                predictSolDirection({
                    solChange15mPct: 1.5,
                    memeBreadthPct: bad,
                    memeVolumeAccel: bad,
                    boostShare: bad,
                    solVolatilityPct: bad,
                }),
            ).not.toThrow();
        }
    });

    it('returns undefined when every weight is zero', () => {
        const result = predictSolDirection(
            { solChange15mPct: 2 },
            { weightMomentum: 0, weightBreadth: 0, weightVolume: 0, weightBoost: 0 },
        );
        expect(result).toBeUndefined();
    });
});

describe('resolveActualDirection and scorePrediction', () => {
    it('treats movement inside the flat band as FLAT', () => {
        expect(resolveActualDirection(0.2, 0.5)).toBe('FLAT');
        expect(resolveActualDirection(-0.2, 0.5)).toBe('FLAT');
        expect(resolveActualDirection(0.9, 0.5)).toBe('UP');
        expect(resolveActualDirection(-0.9, 0.5)).toBe('DOWN');
    });

    it('does not let a 0.02% drift count as a correct UP call', () => {
        // Without the band, the hit rate would measure rounding rather than skill.
        expect(scorePrediction({ direction: 'UP', changePct: 0.02, flatBandPct: 0.5 })).toBe(false);
        expect(scorePrediction({ direction: 'FLAT', changePct: 0.02, flatBandPct: 0.5 })).toBe(true);
    });

    it('grades a real move correctly in both directions', () => {
        expect(scorePrediction({ direction: 'DOWN', changePct: -2, flatBandPct: 0.5 })).toBe(true);
        expect(scorePrediction({ direction: 'DOWN', changePct: 2, flatBandPct: 0.5 })).toBe(false);
    });
});

describe('summariseAccuracy', () => {
    const row = (
        direction: 'UP' | 'DOWN' | 'FLAT',
        actualChangePct: number,
        madeAt: number,
        confidence: 'weak' | 'medium' | 'strong' = 'medium',
    ): ResolvedPrediction => ({ direction, confidence, actualChangePct, madeAt });

    it('returns zeroes rather than NaN when nothing has resolved yet', () => {
        const summary = summariseAccuracy([], 0.5);
        expect(summary.total).toBe(0);
        expect(summary.hitRate).toBe(0);
        expect(summary.baselinePersistence).toBe(0);
        expect(Number.isNaN(summary.hitRate)).toBe(false);
    });

    it('computes the hit rate', () => {
        const summary = summariseAccuracy(
            [row('UP', 2, 1), row('DOWN', -2, 2), row('UP', -2, 3), row('FLAT', 0.1, 4)],
            0.5,
        );
        expect(summary.total).toBe(4);
        expect(summary.correct).toBe(3);
        expect(summary.hitRate).toBeCloseTo(75);
    });

    it('exposes the always-FLAT baseline that makes a bare hit rate meaningless', () => {
        // Every outcome here sat inside the band. A model scoring 25% looks bad until you see that
        // doing nothing at all would have scored 100%.
        const summary = summariseAccuracy(
            [row('UP', 0.1, 1), row('UP', 0.1, 2), row('UP', 0.1, 3), row('FLAT', 0.1, 4)],
            0.5,
        );
        expect(summary.hitRate).toBeCloseTo(25);
        expect(summary.baselineAlwaysFlat).toBeCloseTo(100);
    });

    it('computes the persistence baseline from consecutive outcomes', () => {
        // Outcomes: UP, UP, UP, DOWN -> of the three comparable pairs, two continue.
        const summary = summariseAccuracy(
            [row('UP', 2, 1), row('UP', 2, 2), row('UP', 2, 3), row('UP', -2, 4)],
            0.5,
        );
        expect(summary.baselinePersistence).toBeCloseTo((2 / 3) * 100);
    });

    it('orders by madeAt before computing persistence', () => {
        const shuffled = [row('UP', 2, 3), row('UP', -2, 1), row('UP', -2, 2)];
        // Chronological outcomes are DOWN, DOWN, UP -> one of two pairs continues.
        expect(summariseAccuracy(shuffled, 0.5).baselinePersistence).toBeCloseTo(50);
    });

    it('breaks the hit rate down by confidence, so strong can be checked against weak', () => {
        const summary = summariseAccuracy(
            [
                row('UP', 2, 1, 'strong'),
                row('UP', 2, 2, 'strong'),
                row('UP', -2, 3, 'weak'),
                row('UP', -2, 4, 'weak'),
            ],
            0.5,
        );
        expect(summary.byConfidence.strong).toEqual({ total: 2, hitRate: 100 });
        expect(summary.byConfidence.weak).toEqual({ total: 2, hitRate: 0 });
        expect(summary.byConfidence.medium).toEqual({ total: 0, hitRate: 0 });
    });
});

describe('meetsMinimumConfidence', () => {
    it('ranks the tiers', () => {
        expect(meetsMinimumConfidence('strong', 'medium')).toBe(true);
        expect(meetsMinimumConfidence('medium', 'medium')).toBe(true);
        expect(meetsMinimumConfidence('weak', 'medium')).toBe(false);
        expect(meetsMinimumConfidence('weak', 'weak')).toBe(true);
    });
});

describe('shouldStartAlerting', () => {
    const summary = (over: Partial<AccuracySummary>): AccuracySummary => ({
        total: 100,
        correct: 60,
        hitRate: 60,
        baselineAlwaysFlat: 50,
        baselinePersistence: 50,
        byConfidence: {
            weak: { total: 0, hitRate: 0 },
            medium: { total: 0, hitRate: 0 },
            strong: { total: 0, hitRate: 0 },
        },
        ...over,
    });

    const opts = { minSample: 50, minEdgePoints: 3 };

    it('stays shut until enough calls have been graded', () => {
        const decision = shouldStartAlerting(summary({ total: 12, hitRate: 95 }), opts);
        // 95% on twelve calls is luck, not skill, and must not unlock anything.
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toContain('12/50');
    });

    it('stays shut when it cannot beat the best baseline by the margin', () => {
        const decision = shouldStartAlerting(
            summary({ hitRate: 60, baselineAlwaysFlat: 58, baselinePersistence: 50 }),
            opts,
        );
        expect(decision.allowed).toBe(false);
        expect(decision.edgePoints).toBeCloseTo(2);
    });

    it('measures the margin against the BEST baseline, not against a coin flip', () => {
        // This is the backtest result in miniature: 73.4% looks strong until always-FLAT scores
        // 78.7% on the same rows.
        const decision = shouldStartAlerting(
            summary({ hitRate: 73.4, baselineAlwaysFlat: 78.7, baselinePersistence: 68.8 }),
            opts,
        );
        expect(decision.allowed).toBe(false);
        expect(decision.bestBaseline).toBeCloseTo(78.7);
        expect(decision.edgePoints).toBeLessThan(0);
    });

    it('opens once the sample and the margin are both there', () => {
        const decision = shouldStartAlerting(
            summary({ total: 80, hitRate: 62, baselineAlwaysFlat: 55, baselinePersistence: 52 }),
            opts,
        );
        expect(decision.allowed).toBe(true);
        expect(decision.edgePoints).toBeCloseTo(7);
    });

    it('never divides by zero on an empty record', () => {
        const decision = shouldStartAlerting(summariseAccuracy([], 0.5), opts);
        expect(decision.allowed).toBe(false);
        expect(Number.isNaN(decision.edgePoints)).toBe(false);
    });
});
