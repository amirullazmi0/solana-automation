import { RugCheckApiResponse } from '../dto/analyzer.dto';
import { DEFAULT_MIN_LP_LOCKED_PCT, isMarketLpSafe } from '../common/lp-safety';
import { DEFAULT_MAX_NORMALISED_RISK_SCORE, selectBlockingDangerRisks } from '../common/rugcheck-risk';

export type TagTone = 'DANGER' | 'WARN' | 'GOOD' | 'INFO';

export interface RiskTag {
    /** Stable identifier; the page and the Telegram report word it themselves. */
    code: string;
    tone: TagTone;
    /** What the tag is actually based on, so a reader can judge it rather than trust it. */
    because: string;
}

export interface RiskTagInput {
    /** Undefined when RugCheck never answered, which is NOT the same as clean. */
    report?: RugCheckApiResponse;
    reportFailed?: boolean;
    liquidityUsd?: number;
    volume24h?: number;
    volume5m?: number;
    ageHours?: number;
    buyShare1h?: number;
    /** Reward-to-risk from the zone advice, when both bands exist. */
    rewardRisk?: number;
    /** True when the zone series is too short to lean on. */
    thin?: boolean;
    /** The bot's own last reject reason for this mint, when it is on the watchlist. */
    botReason?: string;
}

/**
 * Turns what is known about a token into a short list of labels.
 *
 * Two rules decide everything here.
 *
 * First, **a safety claim is only made from a safety source.** The rug-risk tags come from
 * RugCheck's own report, judged by the very functions the buy path already uses
 * (`selectBlockingDangerRisks`, `isMarketLpSafe`, `DEFAULT_MAX_NORMALISED_RISK_SCORE`), so the
 * dashboard and the bot cannot reach opposite conclusions about the same token. Nothing infers
 * "safe" from price action, because price action cannot see a mint authority.
 *
 * Second, **silence is never read as clean.** When RugCheck does not answer, the token is tagged
 * `UNCHECKED` rather than left bare: an absent warning and a passed check look identical on screen,
 * and that is the single most expensive confusion this page could cause.
 *
 * `POTENTIAL` is deliberately conservative and deliberately not a safety statement. It says the
 * setup is tradeable -- a real floor below, room above, depth to get in, buyers still present --
 * and it refuses to appear at all while the rug tags are showing.
 */
export function buildRiskTags(input: RiskTagInput): RiskTag[] {
    const tags: RiskTag[] = [];

    const safety = collectRugTags(input, tags);
    collectMarketTags(input, tags);

    if (input.botReason) {
        tags.push({
            code: 'BOT_REJECTED',
            tone: 'INFO',
            because: `bot menolak: ${input.botReason}`,
        });
    }

    // Opportunity needs a check that came back CLEAR, never merely the absence of a warning. An
    // unanswered RugCheck finds no danger and a clean token finds no danger, and only one of those
    // has been examined. It is also withheld whenever the evidence is too thin to support the claim:
    // a green label next to a red one is how a reader ends up believing the green.
    if (safety === 'CLEAR' && isPotential(input)) {
        tags.unshift({
            code: 'POTENTIAL',
            tone: 'GOOD',
            because:
                `untung:rugi ${input.rewardRisk?.toFixed(1)}:1, ` +
                `beli ${input.buyShare1h?.toFixed(0)}% dari trade 1 jam`,
        });
    }

    return tags;
}

type SafetyVerdict = 'CLEAR' | 'DANGER' | 'UNKNOWN';

function collectRugTags(input: RiskTagInput, tags: RiskTag[]): SafetyVerdict {
    const { report } = input;

    if (!report) {
        tags.push({
            code: 'UNCHECKED',
            tone: 'WARN',
            because: input.reportFailed
                ? 'RugCheck tidak menjawab — belum tentu aman, belum diperiksa'
                : 'belum diperiksa RugCheck',
        });
        return 'UNKNOWN';
    }

    let dangerous = false;

    const blocking = selectBlockingDangerRisks(report.risks);
    if (blocking.length > 0) {
        dangerous = true;
        tags.push({
            code: 'RUG_RISK',
            tone: 'DANGER',
            because: blocking
                .map((r) => r.name)
                .slice(0, 3)
                .join(', '),
        });
    }

    // Any market with its LP locked is enough: liquidity that cannot be pulled from one pool is
    // what the check is about, and demanding it of every listed market would fail normal tokens.
    const markets = report.markets ?? [];
    if (markets.length > 0 && !markets.some((m) => isMarketLpSafe(m))) {
        dangerous = true;
        const best = Math.max(...markets.map((m) => m.lp?.lpLockedPct ?? 0));
        tags.push({
            code: 'LP_UNLOCKED',
            tone: 'DANGER',
            because: `LP terkunci ${best.toFixed(0)}%, di bawah ${DEFAULT_MIN_LP_LOCKED_PCT}%`,
        });
    }

    const score = report.score_normalised;
    if (typeof score === 'number' && score > DEFAULT_MAX_NORMALISED_RISK_SCORE) {
        dangerous = true;
        tags.push({
            code: 'HIGH_RISK_SCORE',
            tone: 'DANGER',
            // The raw `score` is an unbounded sum, so only the normalised one is comparable.
            because: `skor risiko ${score.toFixed(0)}/100, batas ${DEFAULT_MAX_NORMALISED_RISK_SCORE}`,
        });
    }

    if (!dangerous) {
        tags.push({
            code: 'RUGCHECK_CLEAR',
            tone: 'GOOD',
            because: `skor ${typeof score === 'number' ? score.toFixed(0) : '?'}/100, tidak ada risiko danger`,
        });
    }

    return dangerous ? 'DANGER' : 'CLEAR';
}

function collectMarketTags(input: RiskTagInput, tags: RiskTag[]): void {
    const { liquidityUsd, volume24h, ageHours } = input;

    // Turnover, not raw volume. $50k of volume means something different on a $20k pool than on a
    // $2m one, and the raw number alone makes the deep pool always look busier.
    if (liquidityUsd && liquidityUsd > 0 && typeof volume24h === 'number') {
        const turnover = volume24h / liquidityUsd;
        if (turnover >= 3) {
            tags.push({
                code: 'BUSY',
                tone: 'INFO',
                because: `volume 24j ${turnover.toFixed(1)}x likuiditas`,
            });
        } else if (turnover < 0.3) {
            tags.push({
                code: 'QUIET',
                tone: 'WARN',
                because: `volume 24j cuma ${turnover.toFixed(2)}x likuiditas — sulit keluar`,
            });
        }
    }

    if (typeof liquidityUsd === 'number' && liquidityUsd < 15_000) {
        tags.push({
            code: 'THIN_LIQUIDITY',
            tone: 'WARN',
            because: `likuiditas $${Math.round(liquidityUsd).toLocaleString('en-US')} — slippage besar`,
        });
    }

    if (typeof ageHours === 'number' && ageHours < 24) {
        tags.push({
            code: 'VERY_NEW',
            tone: 'WARN',
            because: `umur ${ageHours.toFixed(0)} jam`,
        });
    }

    if (typeof input.buyShare1h === 'number' && input.buyShare1h < 40) {
        tags.push({
            code: 'SELLERS_LEADING',
            tone: 'WARN',
            because: `cuma ${input.buyShare1h.toFixed(0)}% beli dari trade 1 jam`,
        });
    }
}

function isPotential(input: RiskTagInput): boolean {
    if (input.thin) return false;
    if ((input.rewardRisk ?? 0) < 2) return false;
    if ((input.liquidityUsd ?? 0) < 25_000) return false;
    if ((input.buyShare1h ?? 0) < 50) return false;
    if ((input.ageHours ?? 0) < 6) return false;
    return true;
}
