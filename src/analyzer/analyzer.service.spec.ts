import { DexScreenerPair } from '../dto/analyzer.dto';
import { DexLimiter } from '../common/dex-limiter';
import {
    AnalyzerService,
    evaluateBearishRebound,
    selectBestDexScreenerPair,
} from './analyzer.service';

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
            {} as never,
            {} as never,
            // Meta label and trend services. These tests drive checkMarketTraction and the
            // holder-concentration tiers, neither of which reads a meta verdict back, so inert
            // stubs keep the constructor satisfied without pulling in the meta pipeline.
            { scheduleLabel: () => undefined, getLabel: () => undefined } as never,
            { recordSighting: () => undefined, isBoosted: () => false } as never,
        );

        const result = await (service as unknown as {
            checkMarketTraction(tokenMint: string): Promise<{ passed: boolean; reason?: string }>;
        }).checkMarketTraction('MINT');

        expect(result.passed).toBe(true);
        expect(result.reason).toBeUndefined();
    });
});

describe('aggressive-high market gates', () => {
    const reboundConfig = { hardFloorPct: -60, minRebound5mPct: 3 };

    it('allows a recovering token without accepting a deep continuing drawdown', () => {
        expect(evaluateBearishRebound(-48, 3.1, reboundConfig)).toEqual({
            allowed: true,
            permanent: false,
        });
        expect(evaluateBearishRebound(-48, 1, reboundConfig)).toEqual({
            allowed: false,
            permanent: false,
        });
        expect(evaluateBearishRebound(-61, 8, reboundConfig)).toEqual({
            allowed: false,
            permanent: true,
        });
    });

    it('uses relaxed holder limits only above the liquidity floor', () => {
        const values: Record<string, number> = {
            MAX_SINGLE_HOLDER_PCT: 8,
            MAX_TOP5_HOLDER_PCT: 15,
            MAX_TOP10_HOLDER_PCT: 20,
            AGGRESSIVE_HOLDER_MIN_LIQUIDITY_USD: 10_000,
            AGGRESSIVE_MAX_SINGLE_HOLDER_PCT: 12,
            AGGRESSIVE_MAX_TOP5_HOLDER_PCT: 28,
            AGGRESSIVE_MAX_TOP10_HOLDER_PCT: 35,
        };
        const service = new AnalyzerService(
            { get: jest.fn((key: string, fallback?: number) => values[key] ?? fallback) } as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            // Meta label and trend services. These tests drive checkMarketTraction and the
            // holder-concentration tiers, neither of which reads a meta verdict back, so inert
            // stubs keep the constructor satisfied without pulling in the meta pipeline.
            { scheduleLabel: () => undefined, getLabel: () => undefined } as never,
            { recordSighting: () => undefined, isBoosted: () => false } as never,
        );
        const rugCheckData = {
            score: 0,
            dangerReasons: [],
            holders: [
                { share: 10, isInPool: false, isBurned: false },
                { share: 7, isInPool: false, isBurned: false },
                { share: 5, isInPool: false, isBurned: false },
                { share: 4, isInPool: false, isBurned: false },
            ],
        };

        expect(service.checkHolderConcentration(rugCheckData as never, 9_999)).toBe(false);
        expect(service.checkHolderConcentration(rugCheckData as never, 10_000)).toBe(true);
    });
});