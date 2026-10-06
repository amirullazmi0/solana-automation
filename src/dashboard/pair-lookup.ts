import { DexLimiter } from '../common/dex-limiter';
import { DexScreenerPair } from '../dto/analyzer.dto';

/**
 * Shared DexScreener lookups for the zone feature.
 *
 * Extracted so the HTTP controller and the Telegram digest resolve coins the same way. Two copies of
 * "deepest pair for this mint" would drift, and a drift there means the web page and the report draw
 * zones from different pools for the same token while both look authoritative.
 */

/** The deepest Solana pair per mint — the same choice `selectBestDexScreenerPair` makes. */
export async function lookupPairs(mints: string[]): Promise<DexScreenerPair[]> {
    if (mints.length === 0) return [];
    const response = await DexLimiter.get<{ pairs?: DexScreenerPair[] }>(
        `https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`,
        { timeout: 8000 },
    );
    const best = new Map<string, DexScreenerPair>();
    for (const p of response.data?.pairs ?? []) {
        const addr = p.baseToken?.address;
        if (!addr || p.chainId !== 'solana') continue;
        const prev = best.get(addr);
        if (prev && (prev.liquidity?.usd || 0) >= (p.liquidity?.usd || 0)) continue;
        best.set(addr, p);
    }
    return [...best.values()];
}

/** The busiest boosted Solana tokens that clear a liquidity floor, deepest volume first. */
export async function busiestFromFeed(
    minLiquidityUsd: number,
    take = 10,
): Promise<DexScreenerPair[]> {
    const feed = await DexLimiter.get<Array<{ chainId: string; tokenAddress: string }>>(
        'https://api.dexscreener.com/token-boosts/latest/v1',
        { timeout: 8000 },
    );
    const mints = [
        ...new Set(
            (feed.data ?? [])
                .filter((t) => t.chainId === 'solana' && t.tokenAddress)
                .map((t) => t.tokenAddress),
        ),
    ].slice(0, 30);

    const pairs = await lookupPairs(mints);
    return pairs
        .filter((p) => (p.liquidity?.usd || 0) >= minLiquidityUsd)
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
        .slice(0, take);
}
