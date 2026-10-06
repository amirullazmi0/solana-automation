import { RugCheckApiResponse } from '../dto/analyzer.dto';
import { buildRiskTags } from './risk-tags';

const codes = (input: Parameters<typeof buildRiskTags>[0]) =>
    buildRiskTags(input).map((t) => t.code);

/** A report that passes every check, so each test can break exactly one thing. */
function cleanReport(over: Partial<RugCheckApiResponse> = {}): RugCheckApiResponse {
    return {
        score_normalised: 12,
        risks: [],
        markets: [{ lp: { lpLockedPct: 100 } }],
        ...over,
    };
}

/** Market data good enough for POTENTIAL, so each test can spoil one input. */
const strongMarket = {
    liquidityUsd: 120_000,
    volume24h: 150_000,
    ageHours: 200,
    buyShare1h: 62,
    rewardRisk: 3.4,
    thin: false,
};

describe('buildRiskTags — safety claims', () => {
    // The single most expensive confusion this page could cause: an absent warning and a passed
    // check look identical on screen, so silence has to be labelled.
    it('says UNCHECKED rather than nothing when RugCheck never answered', () => {
        const tags = buildRiskTags({ reportFailed: true });
        expect(tags.map((t) => t.code)).toContain('UNCHECKED');
        expect(tags.map((t) => t.code)).not.toContain('RUGCHECK_CLEAR');
    });

    it('never claims clear on a missing report', () => {
        expect(codes({})).not.toContain('RUGCHECK_CLEAR');
    });

    it('flags blocking danger risks from RugCheck itself', () => {
        const tags = buildRiskTags({
            report: cleanReport({ risks: [{ level: 'danger', name: 'Mint authority enabled' }] }),
        });
        expect(tags.map((t) => t.code)).toContain('RUG_RISK');
        expect(tags.find((t) => t.code === 'RUG_RISK')?.because).toContain('Mint authority');
    });

    // Low liquidity is enforced directly by the bot's own thresholds, which are stricter and fresher
    // than RugCheck's label, so it must not also appear here as a permanent rug verdict.
    it('ignores the risks the bot enforces itself', () => {
        const tags = codes({ report: cleanReport({ risks: [{ level: 'danger', name: 'Low Liquidity' }] }) });
        expect(tags).not.toContain('RUG_RISK');
        expect(tags).toContain('RUGCHECK_CLEAR');
    });

    it('flags an unlocked LP', () => {
        const tags = buildRiskTags({ report: cleanReport({ markets: [{ lp: { lpLockedPct: 12 } }] }) });
        expect(tags.map((t) => t.code)).toContain('LP_UNLOCKED');
        expect(tags.find((t) => t.code === 'LP_UNLOCKED')?.because).toContain('12%');
    });

    // One pool with locked liquidity is the point; demanding it of every listed market would fail
    // ordinary tokens that happen to be quoted on a second venue.
    it('accepts a token when any one market has its LP locked', () => {
        const tags = codes({
            report: cleanReport({ markets: [{ lp: { lpLockedPct: 4 } }, { lp: { lpLockedPct: 99 } }] }),
        });
        expect(tags).not.toContain('LP_UNLOCKED');
    });

    it('flags a normalised score above the bot threshold', () => {
        expect(codes({ report: cleanReport({ score_normalised: 85 }) })).toContain('HIGH_RISK_SCORE');
        expect(codes({ report: cleanReport({ score_normalised: 60 }) })).not.toContain('HIGH_RISK_SCORE');
    });
});

describe('buildRiskTags — POTENTIAL is withheld, not awarded', () => {
    it('appears on a clean, deep, buyer-led setup with room above', () => {
        const tags = codes({ report: cleanReport(), ...strongMarket });
        expect(tags[0]).toBe('POTENTIAL');
    });

    // A green label beside a red one is how a reader ends up believing the green.
    it('never appears alongside a danger tag', () => {
        const tags = codes({
            report: cleanReport({ risks: [{ level: 'danger', name: 'Mint authority enabled' }] }),
            ...strongMarket,
        });
        expect(tags).toContain('RUG_RISK');
        expect(tags).not.toContain('POTENTIAL');
    });

    it('never appears while RugCheck is unchecked', () => {
        expect(codes({ reportFailed: true, ...strongMarket })).not.toContain('POTENTIAL');
    });

    it('withholds on thin history, weak reward, shallow liquidity, selling, or a new token', () => {
        const spoilers: Array<Partial<typeof strongMarket>> = [
            { thin: true },
            { rewardRisk: 1.2 },
            { liquidityUsd: 9_000 },
            { buyShare1h: 35 },
            { ageHours: 2 },
        ];
        for (const spoiler of spoilers) {
            expect(codes({ report: cleanReport(), ...strongMarket, ...spoiler })).not.toContain(
                'POTENTIAL',
            );
        }
    });
});

describe('buildRiskTags — market condition', () => {
    // Turnover, not raw volume: $50k means something different on a $20k pool than on a $2m one.
    it('judges activity against liquidity rather than in absolute dollars', () => {
        expect(codes({ liquidityUsd: 20_000, volume24h: 100_000 })).toContain('BUSY');
        expect(codes({ liquidityUsd: 2_000_000, volume24h: 100_000 })).toContain('QUIET');
    });

    it('warns that a quiet pool is hard to get out of', () => {
        const tag = buildRiskTags({ liquidityUsd: 100_000, volume24h: 5_000 }).find(
            (t) => t.code === 'QUIET',
        );
        expect(tag?.because).toContain('sulit keluar');
    });

    it('flags shallow liquidity, a very new pair, and seller-led flow', () => {
        const tags = codes({ liquidityUsd: 9_000, ageHours: 3, buyShare1h: 20, volume24h: 40_000 });
        expect(tags).toEqual(expect.arrayContaining(['THIN_LIQUIDITY', 'VERY_NEW', 'SELLERS_LEADING']));
    });

    // The bot's own verdict is real analyzer output and free to read, so it is shown rather than
    // re-derived. It is informational: the bot rejecting a token is not the same as it being unsafe.
    it('passes through the bot reject reason as information, not as danger', () => {
        const tag = buildRiskTags({ botReason: 'low_metrics' }).find((t) => t.code === 'BOT_REJECTED');
        expect(tag?.tone).toBe('INFO');
        expect(tag?.because).toContain('low_metrics');
    });

    it('never throws on an empty input', () => {
        expect(() => buildRiskTags({})).not.toThrow();
    });
});
