/**
 * Buyer dominance expressed as a SHARE of flow rather than a buys-to-sells ratio.
 *
 * The existing 5m gate (`analyzer.service.ts`, reject `low_buyer_dominance`) asks whether
 * `buys < sells * BUY_SELL_RATIO_THRESHOLD`. That only ever sees a five-minute window, so a single
 * burst of buys can pass for momentum while the hour around it is net distribution.
 *
 * A token whose 24h stats read 4,394 buys against 4,504 sells has a 49.4% buy share — sellers
 * outnumber buyers — yet its USD volume split was 50.6% buy-side. The two disagree, which is why
 * share is measured on both counts and volume separately rather than inferred from one.
 */

export interface FlowCounts {
    buys: number;
    sells: number;
}

/**
 * Buyer share of total flow, 0..1. Returns null when there is nothing to measure, which is
 * meaningfully different from a 0% share: a freshly migrated token has no hourly history at all.
 */
export function buyShare(counts: FlowCounts): number | null {
    const buys = Number(counts?.buys);
    const sells = Number(counts?.sells);
    const safeBuys = Number.isFinite(buys) && buys > 0 ? buys : 0;
    const safeSells = Number.isFinite(sells) && sells > 0 ? sells : 0;
    const total = safeBuys + safeSells;
    if (total <= 0) return null;
    return safeBuys / total;
}

/**
 * True when buyer share sits BELOW the threshold, i.e. the gate should reject.
 *
 * Fails open in two cases, both deliberate:
 *   - No data at all. A token minutes past migration has no 1h history; rejecting on that would
 *     shut off the entire MICIN route, which only ever trades young tokens.
 *   - A threshold of 0 or an unparseable one. That is how the gate is switched off in config.
 *
 * Zero sells with positive buys yields a share of 1 and therefore passes, mirroring the
 * `sells5m > 0` guard the 5m gate already applies.
 */
export function failsBuyShare(counts: FlowCounts, minShare: number): boolean {
    const threshold = Number(minShare);
    if (!Number.isFinite(threshold) || threshold <= 0) return false;

    const share = buyShare(counts);
    if (share === null) return false;
    return share < threshold;
}

/** Formats a share for log lines, tolerating the null (no-data) case. */
export function formatBuyShare(share: number | null): string {
    return share === null ? 'n/a' : `${(share * 100).toFixed(1)}%`;
}
