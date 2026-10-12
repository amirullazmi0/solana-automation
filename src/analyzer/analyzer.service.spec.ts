import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DexScreenerPair } from '../dto/analyzer.dto';
import { DexLimiter } from '../common/dex-limiter';
import {
    AnalyzerService,
    evaluateBearishRebound,
    evaluateOverextension,
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

describe('market metric gate ordering', () => {
    const source = readFileSync(resolve(__dirname, 'analyzer.service.ts'), 'utf8');

    /** Urutan kemunculan tiap alasan di dalam sumber. */
    const at = (reason: string) => source.indexOf(`reason: '${reason}'`);

    // `mcap_too_high` adalah satu-satunya penolakan PERMANEN di blok ini. Dulu diperiksa paling
    // akhir, sehingga token yang tersandung gerbang sementara lebih dulu tidak pernah mencapai
    // vonis permanennya dan kembali tiap siklus radar. Produksi membuktikannya: USDC, stablecoin
    // bermcap $9,35 miliar, menghabiskan 50 pemeriksaan lalu berakhir sebagai
    // `stagnant_timeout:low_metrics` — jatah yang seharusnya dipakai kandidat yang masih mungkin.
    it('rejects an oversized market cap before any temporary gate can intercept it', () => {
        const permanent = at('mcap_too_high');
        expect(permanent).toBeGreaterThan(-1);

        for (const temporary of [
            'low_metrics:liquidity',
            'low_metrics:volume5m',
            'low_metrics:buys5m',
            'mcap_too_low',
        ]) {
            expect({ temporary, before: permanent < at(temporary) }).toEqual({
                temporary,
                before: true,
            });
        }
    });

    it('still lets the zero-liquidity hard reject run first', () => {
        expect(at('zero_liquidity')).toBeLessThan(at('mcap_too_high'));
    });

    // Satu nama untuk tiga gerbang membuat 675 penolakan dalam 7 hari tidak bisa dibedakan, dan
    // tidak ada ambang yang bisa disetel dari angka yang tidak bisa dipisahkan.
    it('keeps the three low_metrics gates distinguishable', () => {
        for (const reason of [
            'low_metrics:liquidity',
            'low_metrics:volume5m',
            'low_metrics:buys5m',
        ]) {
            expect({ reason, found: at(reason) > -1 }).toEqual({ reason, found: true });
        }
        // Nama polos tidak boleh kembali: dia yang menyembunyikan gerbang mana yang menolak.
        expect(source).not.toContain("reason: 'low_metrics',");
    });
});

/**
 * CLAUD is the trade this exists for.
 *
 * It signalled on 2026-10-12 at `priceChange1h` +85.18%, nearly double the 45% cap MICIN already
 * enforced, and lost 71% inside the session and 99.8% of its market cap. Nothing was broken in the
 * sense of throwing: both windows simply only ever ran on the MICIN route, and the routes are split
 * by nothing but age -- `resolveRoute` sends anything under two hours to MICIN -- while CLAUD's pair
 * was two hours and forty-seven seconds old. It escaped the cap by under a minute of clock.
 */
describe('evaluateOverextension', () => {
    const caps = { maxPriceChange5mPct: 18, maxPriceChange1hPct: 45 };

    it('rejects the CLAUD entry on either route', () => {
        expect(evaluateOverextension(0, 85.18, caps)).toBe('overextended_1h');
    });

    it('rejects a 5m window that has run too far', () => {
        expect(evaluateOverextension(18.1, 0, caps)).toBe('price_chase');
    });

    // The 5m window is reported first because it is the tighter, more immediate signal, and a
    // reason string that names the wrong window sends the next reader to the wrong knob.
    it('names the 5m window when both windows are breached', () => {
        expect(evaluateOverextension(50, 200, caps)).toBe('price_chase');
    });

    it('allows a token sitting exactly on either cap', () => {
        expect(evaluateOverextension(18, 45, caps)).toBeNull();
        expect(evaluateOverextension(17.9, 44.9, caps)).toBeNull();
    });

    // A token that fell must never be refused for being overextended: that is the bearish-rebound
    // gate's job, and refusing here would silently double up on it.
    it('never refuses a token whose price went down', () => {
        expect(evaluateOverextension(-30, -80, caps)).toBeNull();
    });

    // Zero means off, which is how MICIN_MAX_PRICE_CHANGE_1H shipped before it was given a value.
    it('treats a cap of zero or below as disabled rather than as refuse-everything', () => {
        expect(evaluateOverextension(500, 500, { maxPriceChange5mPct: 0, maxPriceChange1hPct: 0 })).toBeNull();
        expect(evaluateOverextension(500, 500, { maxPriceChange5mPct: -1, maxPriceChange1hPct: -1 })).toBeNull();
    });

    // Missing data passes and an infinite reading does not: blocking on NaN would stop the bot
    // on a DexScreener hiccup, while letting Infinity through would invert the gate at the moment
    // it matters most.
    it('passes a missing reading but refuses an infinite one', () => {
        expect(evaluateOverextension(Number.NaN, Number.NaN, caps)).toBeNull();
        expect(evaluateOverextension(0, Number.POSITIVE_INFINITY, caps)).toBe('overextended_1h');
        expect(
            evaluateOverextension(50, 50, { maxPriceChange5mPct: Number.NaN, maxPriceChange1hPct: Number.NaN }),
        ).toBeNull();
    });
});

/**
 * The gate is only worth anything if it is actually wired to both routes, and the original defect
 * was exactly that it was not. These read the source, because a unit test on the pure function
 * cannot see which routes the caller applies it to.
 */
describe('the overextension gate is wired to both routes', () => {
    const source = readFileSync(resolve(__dirname, 'analyzer.service.ts'), 'utf8');

    it('no longer restricts either price window to MICIN', () => {
        expect(source).not.toContain("route === 'MICIN_ROUTE' && (traction.priceChange5m");
        expect(source).toContain('evaluateOverextension(');
    });

    it('reads the cap for whichever route the token took', () => {
        expect(source).toContain('${routePrefix}_MAX_PRICE_CHANGE_5M');
        expect(source).toContain('${routePrefix}_MAX_PRICE_CHANGE_1H');
    });

    // A knob absent from config.json falls back to the code default, and the 1h default is 0, which
    // means disabled. The gate would then exist and do nothing -- the state WHALE was already in.
    it('has both WHALE caps set to a live value in config.json', () => {
        const config = JSON.parse(
            readFileSync(resolve(__dirname, '..', '..', 'config.json'), 'utf8'),
        ) as Record<string, unknown>;

        expect(config.WHALE_MAX_PRICE_CHANGE_5M).toBeGreaterThan(0);
        expect(config.WHALE_MAX_PRICE_CHANGE_1H).toBeGreaterThan(0);
        // CLAUD signalled at +85.18%; a cap above that would leave the hole open.
        expect(config.WHALE_MAX_PRICE_CHANGE_1H as number).toBeLessThan(85.18);
    });
});
