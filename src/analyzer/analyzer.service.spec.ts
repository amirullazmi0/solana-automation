import { DexScreenerPair } from '../dto/analyzer.dto';
import { DexLimiter } from '../common/dex-limiter';
import { AnalyzerService, selectBestDexScreenerPair } from './analyzer.service';

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

    it('requires the requested mint to be the base token', () => {
        const wrongMint = pair({
            dexId: 'wrong',
            baseToken: { address: 'OTHER' },
            liquidity: { usd: 50000 },
        });
        const matching = pair({
            dexId: 'matching',
            baseToken: { address: 'MINT' },
            liquidity: { usd: 5000 },
        });

        expect(selectBestDexScreenerPair([wrongMint, matching], 'MINT')).toBe(matching);
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

describe('AnalyzerService market-flow entry gate', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('does not classify an early 10-buy and zero-sell flow as a honeypot', async () => {
        const now = Date.now();
        jest.spyOn(DexLimiter, 'get').mockResolvedValue({
            data: {
                pairs: [
                    {
                        chainId: 'solana',
                        dexId: 'pumpfun',
                        baseToken: { address: 'MINT', symbol: 'EARLY', name: 'Early Token' },
                        liquidity: { usd: 10_000 },
                        volume: { m5: 1_000, h1: 1_200 },
                        txns: { m5: { buys: 10, sells: 0 } },
                        fdv: 50_000,
                        pairCreatedAt: now - 60_000,
                        priceChange: { m5: 1, m15: 1, h1: 1 },
                    },
                ],
            },
        } as never);

        const values: Record<string, string | number> = {
            MIN_LIQUIDITY_USD: 5_000,
            MIN_VOLUME_USD: 10,
            MIN_BUY_COUNT: 1,
            MIN_VOLUME_MCAP_RATIO: 0.01,
            MIN_VL_RATIO: 0.01,
            MIN_MCAP: 2_000,
            MAX_MCAP: 5_000_000,
            MIN_AGE_HOURS: 0.005,
            MAX_AGE_HOURS: 48,
            ESTABLISHED_MAX_AGE_HOURS: 48,
            MIN_BUY_CONFIDENCE: 0.6,
            MIN_PRICE_CHANGE_5M_PCT: -0.5,
            ANALYZER_MIN_VOLUME_SURGE: 0.12,
            BUY_SELL_RATIO_THRESHOLD: 1.5,
        };
        const configService = {
            get: jest.fn((key: string, fallback?: string | number) => values[key] ?? fallback),
        };
        const service = new AnalyzerService(
            configService as never,
            {} as never,
            {} as never,
            {} as never,
        );

        const result = await (service as unknown as {
            checkMarketTraction(tokenMint: string): Promise<{ passed: boolean; reason?: string }>;
        }).checkMarketTraction('MINT');

        expect(result.passed).toBe(true);
        expect(result.reason).toBeUndefined();
    });
});
