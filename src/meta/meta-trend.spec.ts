import {
    MetaAggregate,
    computeAcceleration,
    computeHeat,
    metaScoreAdjustment,
    percentileRank,
    resolveToxicThreshold,
} from './meta-trend';

const base = (over: Partial<MetaAggregate> & { label: string }): MetaAggregate => ({
    sightings: 0,
    volumeSum: 0,
    boostCount: 0,
    trades: 0,
    netPnlTotal: 0,
    ...over,
});

describe('percentileRank', () => {
    it('scores a universal tie as neutral rather than as zero', () => {
        // This is what makes a disabled social source harmless: every label ties on that term, so
        // it cancels out instead of dragging the whole board down.
        expect(percentileRank([5, 5, 5], 5)).toBe(50);
        expect(percentileRank([], 0)).toBe(50);
        expect(percentileRank([7], 7)).toBe(50);
    });

    it('ranks a value against its peers', () => {
        expect(percentileRank([1, 2, 3, 4], 4)).toBeGreaterThan(percentileRank([1, 2, 3, 4], 1));
    });
});

describe('computeHeat', () => {
    it('returns an empty map for no evidence', () => {
        expect(computeHeat([]).size).toBe(0);
    });

    it('scores on activity alone until the trade sample is large enough', () => {
        const heat = computeHeat(
            [
                base({ label: 'dog', sightings: 100, volumeSum: 900_000, trades: 2, netPnlTotal: 40 }),
                base({ label: 'cat', sightings: 4, volumeSum: 1_000 }),
            ],
            { minTradeSample: 8 },
        );

        const dog = heat.get('dog');
        expect(dog?.pnlScore).toBeUndefined();
        expect(dog?.heatScore).toBe(dog?.activityScore);
        expect(dog?.reasons.join()).toContain('activity only');
    });

    it('does not crown a meta on a single lucky trade', () => {
        // Two trades at +$20 each is the shape that would otherwise outrank a label with sixty
        // measured trades, purely because the average happens to be large.
        const heat = computeHeat(
            [
                base({ label: 'lucky', sightings: 1, volumeSum: 10, trades: 2, netPnlTotal: 40 }),
                base({ label: 'busy', sightings: 500, volumeSum: 5_000_000 }),
            ],
            { minTradeSample: 8 },
        );

        expect(heat.get('lucky')!.heatScore).toBeLessThan(heat.get('busy')!.heatScore);
        expect(heat.get('lucky')!.tier).not.toBe('TOXIC');
    });

    it('marks a busy but money-losing meta TOXIC despite its activity', () => {
        // The case a pure attention score gets wrong, and the expensive one.
        const heat = computeHeat(
            [
                base({
                    label: 'trap',
                    sightings: 900,
                    volumeSum: 9_000_000,
                    boostCount: 200,
                    trades: 30,
                    netPnlTotal: -45,
                }),
                base({ label: 'quiet', sightings: 2, volumeSum: 50 }),
            ],
            { minTradeSample: 8 },
        );

        expect(heat.get('trap')!.tier).toBe('TOXIC');
        expect(heat.get('trap')!.netPnlPerTrade).toBeCloseTo(-1.5);
    });

    it('requires both a sample and a loss before calling a meta TOXIC', () => {
        const heat = computeHeat(
            [
                // Losing, but only three trades: not enough to condemn the meta.
                base({ label: 'unproven', sightings: 50, volumeSum: 5_000, trades: 3, netPnlTotal: -9 }),
                // Enough trades and profitable: never toxic.
                base({ label: 'good', sightings: 50, volumeSum: 5_000, trades: 20, netPnlTotal: 30 }),
            ],
            { minTradeSample: 8 },
        );

        expect(heat.get('unproven')!.tier).not.toBe('TOXIC');
        expect(heat.get('good')!.tier).not.toBe('TOXIC');
    });

    it('lets realised P&L outrank raw activity once both labels have a sample', () => {
        const heat = computeHeat(
            [
                base({ label: 'loud', sightings: 900, volumeSum: 9_000_000, trades: 20, netPnlTotal: 2 }),
                base({ label: 'quiet', sightings: 10, volumeSum: 1_000, trades: 20, netPnlTotal: 120 }),
            ],
            { minTradeSample: 8, pnlWeight: 0.6 },
        );

        expect(heat.get('quiet')!.heatScore).toBeGreaterThan(heat.get('loud')!.heatScore);
    });

    it('keeps the score on a 0..100 scale whatever the weights are set to', () => {
        const heat = computeHeat(
            [
                base({ label: 'a', sightings: 10, volumeSum: 100 }),
                base({ label: 'b', sightings: 1, volumeSum: 1 }),
            ],
            { weightSightings: 9, weightVolume: 4, weightBoost: 0.5, weightSocial: 7 },
        );

        for (const entry of heat.values()) {
            expect(entry.heatScore).toBeGreaterThanOrEqual(0);
            expect(entry.heatScore).toBeLessThanOrEqual(100);
        }
    });

    it('reports win rate from the wins it was given', () => {
        const heat = computeHeat([base({ label: 'dog', trades: 10, wins: 7, netPnlTotal: 5 })], {
            minTradeSample: 8,
        });
        expect(heat.get('dog')!.winRate).toBeCloseTo(70);
    });

    it('does not divide by zero for a label with no trades', () => {
        const heat = computeHeat([base({ label: 'dog', sightings: 3 })]);
        expect(heat.get('dog')!.netPnlPerTrade).toBe(0);
        expect(heat.get('dog')!.winRate).toBe(0);
    });
});

describe('metaScoreAdjustment', () => {
    const bonuses = { hot: 14, warm: 6, toxicPenalty: 18 };

    it('rewards heat and punishes a meta measured losing money', () => {
        expect(metaScoreAdjustment('HOT', bonuses)).toBe(14);
        expect(metaScoreAdjustment('WARM', bonuses)).toBe(6);
        expect(metaScoreAdjustment('COLD', bonuses)).toBe(0);
        expect(metaScoreAdjustment('TOXIC', bonuses)).toBe(-18);
    });

    it('treats an absent tier as no opinion, never as a weak match', () => {
        // An unlabelled token must score exactly as it did before this feature existed.
        expect(metaScoreAdjustment(undefined, bonuses)).toBe(0);
    });

    it('penalises a toxic meta harder than it rewards a hot one', () => {
        // Asymmetric because the mistakes are: a missed trade versus a filled position in
        // something already measured burning money.
        expect(Math.abs(metaScoreAdjustment('TOXIC', bonuses))).toBeGreaterThan(
            metaScoreAdjustment('HOT', bonuses),
        );
    });
});

describe('computeAcceleration', () => {
    const window = { windowMinutes: 720, recentMinutes: 60 };

    it('reports a meta launching faster now than earlier as above 1', () => {
        // 8 in the last hour against 12 across the previous eleven: waking up.
        const ratio = computeAcceleration({ sightings: 20, recentSightings: 8, ...window });
        expect(ratio).toBeGreaterThan(1);
    });

    it('reports a fading meta as below 1', () => {
        // 1 in the last hour against 39 before it: the run already happened.
        const ratio = computeAcceleration({ sightings: 40, recentSightings: 1, ...window });
        expect(ratio).toBeLessThan(1);
    });

    it('reports a steady meta as roughly flat', () => {
        // 60 sightings spread evenly over 720 minutes means 5 in any 60-minute slice.
        const ratio = computeAcceleration({ sightings: 60, recentSightings: 5, ...window });
        expect(ratio).toBeGreaterThan(0.9);
        expect(ratio).toBeLessThan(1.1);
    });

    it('does not let a brand-new label divide by zero and rank first forever', () => {
        // Every sighting inside the recent slice, so there is no history to compare against. The
        // baseline floor is what stops this becoming Infinity on three sightings.
        const ratio = computeAcceleration({ sightings: 3, recentSightings: 3, ...window });
        expect(Number.isFinite(ratio)).toBe(true);
        expect(ratio).toBeGreaterThan(1);
    });

    it('still ranks a big new label above a small new one, once a baseline exists', () => {
        // Legitimate only because the span is full: the chain has been watched for twelve hours
        // and these labels genuinely appeared from nothing inside the last one.
        const span = { ...window, dataSpanMinutes: 720 };
        const small = computeAcceleration({ sightings: 3, recentSightings: 3, ...span });
        const large = computeAcceleration({ sightings: 30, recentSightings: 30, ...span });
        expect(large).toBeGreaterThan(small);
    });

    it('stays flat while the bot has not been collecting longer than the recent slice', () => {
        // Regression. Seen in production minutes after a deploy: four labels with 2, 2, 2 and 4
        // sightings reported 22.00x, 22.00x, 22.00x and 44.00x -- the ratio was exactly
        // `sightings x 11`, a restated count wearing the units of a rate, and identical constants
        // across unrelated labels are the same tell volumeSurge gave.
        for (const [sightings, span] of [
            [2, 6],
            [4, 6],
            [10, 45],
            [3, 60],
        ] as const) {
            expect(
                computeAcceleration({
                    sightings,
                    recentSightings: sightings,
                    windowMinutes: 720,
                    recentMinutes: 60,
                    dataSpanMinutes: span,
                }),
            ).toBe(1);
        }
    });

    it('starts giving an opinion once the span exceeds the recent slice', () => {
        const ratio = computeAcceleration({
            sightings: 10,
            recentSightings: 8,
            windowMinutes: 720,
            recentMinutes: 60,
            dataSpanMinutes: 180,
        });
        expect(ratio).toBeGreaterThan(1);
        expect(Number.isFinite(ratio)).toBe(true);
    });

    it('answers flat when the arithmetic is not meaningful', () => {
        // The trap volumeSurge fell into: a recent slice as long as the window leaves nothing to
        // compare against, and every label would otherwise collapse to the same constant.
        expect(computeAcceleration({ sightings: 10, recentSightings: 10, windowMinutes: 60, recentMinutes: 60 })).toBe(1);
        expect(computeAcceleration({ sightings: 0, recentSightings: 0, ...window })).toBe(1);
        expect(computeAcceleration({ sightings: 10, recentSightings: 0, windowMinutes: 0, recentMinutes: 0 })).toBe(1);
    });

    it('clamps a recent count that exceeds the total instead of going negative', () => {
        const ratio = computeAcceleration({ sightings: 5, recentSightings: 99, ...window });
        expect(Number.isFinite(ratio)).toBe(true);
        expect(ratio).toBeGreaterThan(0);
    });
});

describe('computeHeat acceleration term', () => {
    it('ranks an accelerating meta above an equally busy but fading one', () => {
        // Identical level, opposite direction. Without the acceleration term these two would tie,
        // which is exactly the blind spot it was added to remove.
        const heat = computeHeat([
            base({
                label: 'rising',
                sightings: 20,
                volumeSum: 10_000,
                recentSightings: 15,
                windowMinutes: 720,
                recentMinutes: 60,
            }),
            base({
                label: 'fading',
                sightings: 20,
                volumeSum: 10_000,
                recentSightings: 1,
                windowMinutes: 720,
                recentMinutes: 60,
            }),
        ]);

        expect(heat.get('rising')!.accelRatio).toBeGreaterThan(heat.get('fading')!.accelRatio);
        expect(heat.get('rising')!.heatScore).toBeGreaterThan(heat.get('fading')!.heatScore);
    });

    it('defaults to flat when no window information is supplied', () => {
        // The snapshot script has no history at all; it must not be reported as accelerating.
        const heat = computeHeat([base({ label: 'dog', sightings: 5, volumeSum: 100 })]);
        expect(heat.get('dog')!.accelRatio).toBe(1);
    });
});

describe('resolveToxicThreshold', () => {
    it('sets the bar from the fees those trades actually paid', () => {
        // 20 trades, $4 of fees total = $0.20 per trade. At 1.5x, a meta must lose more than
        // $0.30 per trade before the loss says anything beyond "it paid the spread".
        const threshold = resolveToxicThreshold({
            feeTotalUsd: 4,
            trades: 20,
            feeMultiple: 1.5,
            minLossUsd: 0.2,
        });
        expect(threshold).toBeCloseTo(-0.3);
    });

    it('falls back to the absolute floor when fee data is missing', () => {
        // Older rows have no totalFeesSol. Without the floor the threshold collapses to zero and
        // every break-even meta becomes toxic again.
        const threshold = resolveToxicThreshold({
            feeTotalUsd: 0,
            trades: 20,
            feeMultiple: 1.5,
            minLossUsd: 0.2,
        });
        expect(threshold).toBeCloseTo(-0.2);
    });

    it('takes whichever bar is higher, never the lower one', () => {
        const threshold = resolveToxicThreshold({
            feeTotalUsd: 20,
            trades: 20,
            feeMultiple: 1.5,
            minLossUsd: 0.2,
        });
        expect(threshold).toBeCloseTo(-1.5);
    });

    it('never returns a positive bar, whatever it is handed', () => {
        for (const input of [
            { feeTotalUsd: -5, trades: 10, feeMultiple: 1.5, minLossUsd: 0.2 },
            { feeTotalUsd: 5, trades: 0, feeMultiple: -3, minLossUsd: -1 },
        ]) {
            expect(resolveToxicThreshold(input)).toBeLessThanOrEqual(0);
        }
    });
});

describe('computeHeat toxic threshold', () => {
    const feeDrag = { trades: 20, feeTotalUsd: 4 }; // $0.20 per trade

    it('does not condemn a meta that merely paid the fees', () => {
        // This is the whole reason the threshold exists. Twenty trades that went nowhere show a
        // net of -$0.20 each purely from fees; calling that TOXIC would reject the average meta
        // rather than the bad ones, and with the gate on it would choke the bot.
        const heat = computeHeat(
            [
                base({ label: 'flat', sightings: 40, volumeSum: 5_000, netPnlTotal: -4, ...feeDrag }),
                base({ label: 'other', sightings: 10, volumeSum: 500 }),
            ],
            { minTradeSample: 8 },
        );

        expect(heat.get('flat')!.tier).not.toBe('TOXIC');
        expect(heat.get('flat')!.netPnlPerTrade).toBeCloseTo(-0.2);
    });

    it('still condemns a meta losing well beyond its fees', () => {
        const heat = computeHeat(
            [
                base({ label: 'trap', sightings: 40, volumeSum: 5_000, netPnlTotal: -30, ...feeDrag }),
                base({ label: 'other', sightings: 10, volumeSum: 500 }),
            ],
            { minTradeSample: 8 },
        );

        expect(heat.get('trap')!.tier).toBe('TOXIC');
        expect(heat.get('trap')!.netPnlPerTrade).toBeCloseTo(-1.5);
    });

    it('exposes the bar it used so the decision can be audited', () => {
        const heat = computeHeat([base({ label: 'x', netPnlTotal: -4, ...feeDrag })], {
            minTradeSample: 8,
        });
        expect(heat.get('x')!.toxicThreshold).toBeCloseTo(-0.3);
        expect(heat.get('x')!.reasons.join()).toContain('toxic below');
    });
});

describe('computeHeat during the bootstrap period', () => {
    it('does not let acceleration double-count the level right after a restart', () => {
        // The production symptom: every sighting sits inside the recent slice, so a broken
        // acceleration term simply re-ranks labels by count -- and the blend then spends both the
        // sightings weight AND the acceleration weight on one signal.
        const boot = { windowMinutes: 720, recentMinutes: 60, dataSpanMinutes: 7 };
        const heat = computeHeat([
            base({ label: 'animal', sightings: 4, recentSightings: 4, volumeSum: 3_000, ...boot }),
            base({ label: 'crypto', sightings: 2, recentSightings: 2, volumeSum: 2_000, ...boot }),
            base({ label: 'ai', sightings: 2, recentSightings: 2, volumeSum: 1_000, ...boot }),
            base({ label: 'solana', sightings: 2, recentSightings: 2, volumeSum: 500, ...boot }),
        ]);

        // Every label ties at flat, so the term contributes a neutral percentile to all of them
        // and cancels out of the ranking entirely.
        for (const entry of heat.values()) expect(entry.accelRatio).toBe(1);

        // Ranking still works, driven by the terms that do have evidence.
        expect(heat.get('animal')!.heatScore).toBeGreaterThan(heat.get('solana')!.heatScore);
    });
});
