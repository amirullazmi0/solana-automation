import { RugCheckMarket } from '../dto/analyzer.dto';

export const DEFAULT_MIN_LP_LOCKED_PCT = 90;

/**
 * RugCheck's v1 report never returned the flat `lpType` / `lpStatus` strings this project
 * originally matched on — the lock state lives in `market.lp.lpLockedPct` (0-100). Matching the
 * absent fields made `lpSafe` evaluate to false for every token that had a market at all, so
 * every post-migration token was permanently rejected with `lp_not_burned`.
 *
 * The legacy string comparison is kept as a fallback so older/cached payloads still resolve.
 */
export function isMarketLpSafe(
    market: RugCheckMarket | undefined,
    minLockedPct = DEFAULT_MIN_LP_LOCKED_PCT,
): boolean {
    if (!market) return false;

    if (
        market.lpType === 'burned' ||
        market.lpStatus === 'burned' ||
        market.lpType === 'locked' ||
        market.lpStatus === 'locked'
    ) {
        return true;
    }

    const lockedPct = Number(market.lp?.lpLockedPct);
    return Number.isFinite(lockedPct) && lockedPct >= minLockedPct;
}

/**
 * A token is sellable as long as at least one of its markets has its LP locked or burned;
 * a second, unlocked pool does not make the locked one unsafe to trade against.
 */
export function isLpSafe(
    markets: RugCheckMarket[] | undefined,
    minLockedPct = DEFAULT_MIN_LP_LOCKED_PCT,
): boolean {
    return (markets || []).some((market) => isMarketLpSafe(market, minLockedPct));
}

/** Highest lock percentage across all markets, for logging and telemetry. */
export function maxLpLockedPct(markets: RugCheckMarket[] | undefined): number {
    return (markets || []).reduce((highest, market) => {
        const lockedPct = Number(market.lp?.lpLockedPct);
        return Number.isFinite(lockedPct) && lockedPct > highest ? lockedPct : highest;
    }, 0);
}
