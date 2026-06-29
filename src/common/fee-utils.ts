/**
 * Net realized PnL in USD for a closed (or partially closed) trade.
 *
 * `profitUsd` is stored GROSS (price delta only); fees are tracked separately in
 * `totalFeesSol`. Net = gross − fees(USD), valuing the fees at the SOL price captured
 * at entry so the result is deterministic from already-stored fields (no live SOL price
 * needed, no DB migration). Falls back to gross when `solPriceAtEntry` is missing/invalid.
 *
 * Lives in `common/` (not `trade.service`) to avoid a circular import between
 * TradeService and ReportingService, which both consume it.
 */
export function computeNetProfitUsd(trade: {
    profitUsd?: number | null;
    totalFeesSol?: number | null;
    solPriceAtEntry?: number | null;
}): number {
    const gross = Number(trade.profitUsd ?? 0);
    const feesSol = Number(trade.totalFeesSol ?? 0);
    const solPrice = Number(trade.solPriceAtEntry ?? 0);
    if (!Number.isFinite(gross)) return 0;
    if (!Number.isFinite(solPrice) || solPrice <= 0 || !Number.isFinite(feesSol)) return gross;
    return gross - feesSol * solPrice;
}
