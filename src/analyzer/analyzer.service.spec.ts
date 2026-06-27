import { DexScreenerPair } from '../dto/analyzer.dto';
import { selectBestDexScreenerPair } from './analyzer.service';

describe('selectBestDexScreenerPair', () => {
    const pair = (overrides: Partial<DexScreenerPair>): DexScreenerPair => ({
        chainId: 'solana',
        dexId: 'raydium',
        liquidity: { usd: 0 },
        volume: { m5: 0 },
        txns: { m5: { buys: 0, sells: 0 } },
        ...overrides,
    });

    it('selects the Solana pair with the deepest liquidity', () => {
        const shallow = pair({ dexId: 'shallow', liquidity: { usd: 1000 }, volume: { m5: 5000 } });
        const deep = pair({ dexId: 'deep', liquidity: { usd: 12000 }, volume: { m5: 100 } });
        const nonSolana = pair({ chainId: 'ethereum', dexId: 'eth', liquidity: { usd: 50000 } });

        expect(selectBestDexScreenerPair([shallow, nonSolana, deep])).toBe(deep);
    });

    it('uses volume and transaction activity as tie breakers', () => {
        const quiet = pair({ dexId: 'quiet', liquidity: { usd: 5000 }, volume: { m5: 10 } });
        const active = pair({
            dexId: 'active',
            liquidity: { usd: 5000 },
            volume: { m5: 10 },
            txns: { m5: { buys: 5, sells: 2 } },
        });
        const louder = pair({ dexId: 'louder', liquidity: { usd: 5000 }, volume: { m5: 200 } });

        expect(selectBestDexScreenerPair([quiet, active, louder])).toBe(louder);
        expect(selectBestDexScreenerPair([quiet, active])).toBe(active);
    });

    it('returns undefined when there is no Solana pair', () => {
        expect(selectBestDexScreenerPair([pair({ chainId: 'ethereum' })])).toBeUndefined();
        expect(selectBestDexScreenerPair(undefined)).toBeUndefined();
    });

    it('still returns a Solana pair when all liquidity is zero', () => {
        const older = pair({ dexId: 'older', pairCreatedAt: 100, volume: { m5: 20 } });
        const newer = pair({ dexId: 'newer', pairCreatedAt: 200, volume: { m5: 20 } });

        expect(selectBestDexScreenerPair([older, newer])).toBe(newer);
    });
});