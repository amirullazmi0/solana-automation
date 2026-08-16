import {
    DEFAULT_HOLDER_DATA_SETTLE_MINUTES,
    DEFAULT_MAX_NORMALISED_RISK_SCORE,
    exceedsRiskScore,
    isHolderDataSettled,
    isSelfEnforcedRisk,
    resolveNormalisedRiskScore,
    selectBlockingDangerRisks,
} from './rugcheck-risk';

describe('rugcheck-risk', () => {
    describe('risk score scale', () => {
        // $3Zrpw7RW, 2026-08-15: raw score 2979, of which 2978 came from a single "Low Liquidity"
        // risk, while score_normalised was 34 and the holder spread was near-perfect
        // (single 0.05%, top10 0.1%). The raw-vs-1000 comparison rejected it permanently.
        it('judges the bounded rating, not the unbounded raw sum', () => {
            expect(exceedsRiskScore(34)).toBe(false);
            expect(DEFAULT_MAX_NORMALISED_RISK_SCORE).toBe(60);
        });

        it('still rejects a genuinely high normalised rating', () => {
            expect(exceedsRiskScore(61)).toBe(true);
            expect(exceedsRiskScore(100)).toBe(true);
        });

        it('honours a custom threshold and ignores a nonsensical one', () => {
            expect(exceedsRiskScore(34, 20)).toBe(true);
            expect(exceedsRiskScore(34, 0)).toBe(false); // falls back to the default 60
            expect(exceedsRiskScore(34, Number.NaN)).toBe(false);
        });

        it('treats a missing rating as no opinion rather than falling back to the raw score', () => {
            expect(resolveNormalisedRiskScore(undefined)).toBe(0);
            expect(resolveNormalisedRiskScore(Number.NaN)).toBe(0);
            expect(resolveNormalisedRiskScore(-5)).toBe(0);
            expect(exceedsRiskScore(undefined)).toBe(false);
        });
    });

    describe('blocking danger risks', () => {
        const risks = [
            { level: 'danger', name: 'Low Liquidity' },
            { level: 'danger', name: 'Creator history of rugged tokens' },
            { level: 'warn', name: 'Mutable metadata' },
        ];

        it('drops liquidity risks, which MIN_LIQUIDITY_USD already enforces more strictly', () => {
            expect(isSelfEnforcedRisk('Low Liquidity')).toBe(true);
            expect(isSelfEnforcedRisk('Low amount of liquidity in the token pool')).toBe(true);
        });

        it('keeps every other danger risk blocking', () => {
            const blocking = selectBlockingDangerRisks(risks);
            expect(blocking.map((r) => r.name)).toEqual(['Creator history of rugged tokens']);
        });

        it('never promotes a non-danger risk to blocking', () => {
            expect(selectBlockingDangerRisks([{ level: 'warn', name: 'Anything' }])).toEqual([]);
            expect(selectBlockingDangerRisks(undefined)).toEqual([]);
        });

        it('does not treat an unrelated risk as self-enforced', () => {
            expect(isSelfEnforcedRisk('Honeypot')).toBe(false);
            expect(isSelfEnforcedRisk(undefined)).toBe(false);
        });
    });

    describe('holder data settling', () => {
        const MINUTE = 60 * 1000;

        it('treats a freshly migrated token as unsettled so the reject is not permanent', () => {
            expect(isHolderDataSettled(30 * 1000)).toBe(false);
            expect(isHolderDataSettled(5 * MINUTE)).toBe(false);
            expect(DEFAULT_HOLDER_DATA_SETTLE_MINUTES).toBe(10);
        });

        it('treats a matured token as settled so the reject stays permanent', () => {
            expect(isHolderDataSettled(11 * MINUTE)).toBe(true);
            expect(isHolderDataSettled(60 * MINUTE)).toBe(true);
        });

        it('keeps the previous behaviour when the age is unknown', () => {
            expect(isHolderDataSettled(undefined)).toBe(true);
            expect(isHolderDataSettled(0)).toBe(true);
        });

        it('respects a custom settle window', () => {
            expect(isHolderDataSettled(5 * MINUTE, 3)).toBe(true);
            expect(isHolderDataSettled(5 * MINUTE, 30)).toBe(false);
        });
    });
});
