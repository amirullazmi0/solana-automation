import { DexScreenerPair } from '../dto/analyzer.dto';

function finitePositive(value: number | undefined): number {
    return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
}

export function selectBestDexScreenerPair(
    pairs: DexScreenerPair[] | undefined,
    tokenMint?: string,
): DexScreenerPair | undefined {
    const normalizedMint = tokenMint?.toLowerCase();
    return (pairs || [])
        .filter(
            (pair) =>
                (!pair.chainId || pair.chainId.toLowerCase() === 'solana') &&
                (!normalizedMint || pair.baseToken?.address?.toLowerCase() === normalizedMint),
        )
        .sort((a, b) => {
            const liquidityDelta =
                finitePositive(b.liquidity?.usd) - finitePositive(a.liquidity?.usd);
            if (liquidityDelta !== 0) return liquidityDelta;
            const volumeDelta = finitePositive(b.volume?.m5) - finitePositive(a.volume?.m5);
            if (volumeDelta !== 0) return volumeDelta;
            const bTxns = finitePositive(b.txns?.m5?.buys) + finitePositive(b.txns?.m5?.sells);
            const aTxns = finitePositive(a.txns?.m5?.buys) + finitePositive(a.txns?.m5?.sells);
            if (bTxns !== aTxns) return bTxns - aTxns;
            return (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0);
        })[0];
}
