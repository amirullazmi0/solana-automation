import { PriceMonitorService, resolveMonitorSolPriceBasis } from './price-monitor.service';
import { DexLimiter } from '../common/dex-limiter';


describe('resolveMonitorSolPriceBasis', () => {
    it('keeps SOL-denominated trade prices as SOL basis', () => {
        const basis = resolveMonitorSolPriceBasis({
            currentPriceUsd: 0.00015,
            currentSolUsd: 75,
            entryPrice: 0.0000015,
            highestPrice: 0.000002,
            trailingStopPrice: 0.0000018,
            solPriceAtEntry: 70,
        });

        expect(basis?.basis).toBe('sol');
        expect(basis?.currentPriceSol).toBeCloseTo(0.000002, 10);
        expect(basis?.entryPriceSol).toBeCloseTo(0.0000015, 10);
    });

    it('converts legacy USD-denominated trade prices to SOL basis', () => {
        const basis = resolveMonitorSolPriceBasis({
            currentPriceUsd: 0.00015,
            currentSolUsd: 75,
            entryPrice: 0.000105,
            highestPrice: 0.00014,
            trailingStopPrice: 0.000126,
            solPriceAtEntry: 70,
        });

        expect(basis?.basis).toBe('legacy_usd_converted');
        expect(basis?.entryPriceSol).toBeCloseTo(0.0000015, 10);
        expect(basis?.highestPriceSol).toBeCloseTo(0.000002, 10);
        expect(basis?.trailingStopPriceSol).toBeCloseTo(0.0000018, 10);
    });
});

describe('PriceMonitorService conservative exit guard', () => {
    function createService(config: Record<string, unknown> = {}) {
        const configService = {
            get: jest.fn((key: string, fallback?: unknown) =>
                Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback,
            ),
        };

        return new PriceMonitorService(
            configService as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
        ) as unknown as {
            shouldGuardEarlyNonCriticalExit: (
                trade: { createdAt: Date },
                exitReason: string,
                profitPercent: number,
                nowMs?: number,
            ) => boolean;
            shouldRunEarlyExitHealthCheck: (exitReason: string) => boolean;
            estimateNetProfitPercent: (
                trade: { entryValueUsd?: number | null; solPriceAtEntry?: number | null; totalFeesSol?: number | null },
                grossProfitPercent: number,
            ) => number;
        };
    }

    it('guards stop-loss and trailing exits inside the configured minimum hold window', () => {
        const service = createService({ MIN_NON_CRITICAL_HOLD_SECONDS: 60 });
        const now = Date.now();
        const trade = { createdAt: new Date(now - 30_000) };

        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'STOP_LOSS', -10, now)).toBe(true);
        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'TRAILING_STOP', -10, now)).toBe(true);
    });

    it('allows non-critical exits after the minimum hold window', () => {
        const service = createService({ MIN_NON_CRITICAL_HOLD_SECONDS: 60 });
        const now = Date.now();
        const trade = { createdAt: new Date(now - 61_000) };

        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'STOP_LOSS', -10, now)).toBe(false);
    });

    it('does not guard emergency exits', () => {
        const service = createService({ MIN_NON_CRITICAL_HOLD_SECONDS: 60 });
        const now = Date.now();
        const trade = { createdAt: new Date(now - 10_000) };

        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'PANIC_SELL', -10, now)).toBe(false);
        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'DEV_DUMP', -10, now)).toBe(false);
        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'RUGPULL', -10, now)).toBe(false);
    });

    it('respects config switches for guard and health checks', () => {
        const service = createService({
            ENABLE_CONSERVATIVE_EXIT_GUARD: false,
            HEALTH_CHECK_BEFORE_EARLY_SL: false,
            HEALTH_CHECK_BEFORE_EARLY_TRAILING: true,
        });
        const now = Date.now();
        const trade = { createdAt: new Date(now - 10_000) };

        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'STOP_LOSS', -10, now)).toBe(false);
        expect(service.shouldRunEarlyExitHealthCheck('STOP_LOSS')).toBe(false);
        expect(service.shouldRunEarlyExitHealthCheck('TRAILING_STOP')).toBe(true);
    });
    it('stops guarding STOP_LOSS once loss exceeds the depth floor, regardless of trade age', () => {
        const service = createService({
            MIN_NON_CRITICAL_HOLD_SECONDS: 60,
            STOP_LOSS_GUARD_DEPTH_FLOOR_PERCENT: 20,
        });
        const now = Date.now();
        // Well inside the minimum hold window (age << 60s), so age alone would still guard.
        const trade = { createdAt: new Date(now - 5_000) };

        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'STOP_LOSS', -19.9, now)).toBe(true);
        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'STOP_LOSS', -20, now)).toBe(false);
        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'STOP_LOSS', -35, now)).toBe(false);
        // TRAILING_STOP is not subject to the STOP_LOSS depth floor; age still governs it.
        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'TRAILING_STOP', -35, now)).toBe(true);
    });
    it('estimates net profit after buy and sell fee drag above the Jito threshold', () => {
        const service = createService({
            USE_JITO: true,
            JITO_TIP_SOL: 0.001,
            JITO_MIN_POSITION_USD: 7,
            DEX_FEE_ROUNDTRIP_PERCENT: 1.0,
        });

        const netProfit = service.estimateNetProfitPercent(
            { entryValueUsd: 8, solPriceAtEntry: 75, totalFeesSol: 0.001 },
            8,
        );

        // gross 8% - tip/network drag ((0.001 + 0.001 + 0.00001) * 75 / 8 * 100 = 1.884375)
        //          - DEX/slippage allowance (1.0) = 5.115625
        expect(netProfit).toBeCloseTo(5.115625, 2);
    });

    it('excludes the sell Jito tip from fee drag for sub-threshold (<$3) positions', () => {
        const service = createService({
            USE_JITO: true,
            JITO_TIP_SOL: 0.001,
            JITO_MIN_POSITION_USD: 7,
            DEX_FEE_ROUNDTRIP_PERCENT: 1.0,
        });

        // entryValueUsd = 2 (< $3): the sell skips Jito at execution, so no sell tip in drag.
        const netProfit = service.estimateNetProfitPercent(
            { entryValueUsd: 2, solPriceAtEntry: 75, totalFeesSol: 0.001 },
            8,
        );

        // gross 8 - ((0.001 + 0.00001) * 75 / 2 * 100 = 3.7875) - DEX 1.0 = 3.2125
        expect(netProfit).toBeCloseTo(3.2125, 2);
    });

    it('holds a small trailing exit when AI health is healthy', async () => {
        const executeSell = jest.fn();
        const service = new PriceMonitorService(
            {
                get: jest.fn((key: string, fallback?: unknown) => {
                    const config: Record<string, unknown> = {
                        MIN_NET_EXIT_PROFIT_PERCENT: 3,
                        USE_JITO: true,
                        JITO_TIP_SOL: 0.001,
                        HEALTH_CHECK_BEFORE_EARLY_TRAILING: true,
                    };
                    return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback;
                }),
            } as never,
            { watchlist: { findUnique: jest.fn().mockResolvedValue(null) } } as never,
            { executeSell } as never,
            {} as never,
            {} as never,
            {
                evaluateTokenHealth: jest.fn().mockResolvedValue({
                    status: 'HEALTHY',
                    confidenceLevel: 'high',
                    reasoning: 'buy pressure masih sehat',
                    reentrySignal: true,
                }),
            } as never,
        ) as unknown as {
            handleTrailingExitHealthGuard: (
                trade: Record<string, unknown>,
                currentPrice: number,
                profitPercent: number,
                effectiveStopLossPercent: number,
                signals: Record<string, unknown>,
            ) => Promise<boolean>;
        };

        const held = await service.handleTrailingExitHealthGuard(
            {
                id: 7,
                slotNumber: 1,
                tokenMint: 'mint',
                symbol: 'TEST',
                route: 'MICIN',
                createdAt: new Date(),
                partialTakeProfitAt: null,
                entryValueUsd: 3,
                solPriceAtEntry: 75,
                totalFeesSol: 0.001,
            },
            0.0001,
            6,
            11,
            {
                priceUsd: 0.0001,
                volScore: 0.35,
                priceChange1h: 20,
                liquidityUsd: 10000,
                marketCapUsd: 50000,
                volume5mUsd: 1000,
                volume1hUsd: 10000,
                buys5mCount: 8,
                sells5mCount: 5,
                volumeSurge: 1.2,
                zScore: 2,
            },
        );

        expect(held).toBe(true);
        expect(executeSell).not.toHaveBeenCalled();
    });

    it('forces sell when trailing health check is critical', async () => {
        const executeSell = jest.fn();
        const service = new PriceMonitorService(
            {
                get: jest.fn((key: string, fallback?: unknown) => {
                    const config: Record<string, unknown> = {
                        MIN_NET_EXIT_PROFIT_PERCENT: 3,
                        HEALTH_CHECK_BEFORE_EARLY_TRAILING: true,
                    };
                    return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback;
                }),
            } as never,
            { watchlist: { findUnique: jest.fn().mockResolvedValue(null) } } as never,
            { executeSell } as never,
            {} as never,
            {} as never,
            {
                evaluateTokenHealth: jest.fn().mockResolvedValue({
                    status: 'CRITICAL',
                    confidenceLevel: 'high',
                    reasoning: 'flow patah',
                    reentrySignal: false,
                }),
            } as never,
        ) as unknown as {
            handleTrailingExitHealthGuard: (
                trade: Record<string, unknown>,
                currentPrice: number,
                profitPercent: number,
                effectiveStopLossPercent: number,
                signals: Record<string, unknown>,
            ) => Promise<boolean>;
        };

        const handled = await service.handleTrailingExitHealthGuard(
            {
                id: 8,
                slotNumber: 1,
                tokenMint: 'mint',
                symbol: 'TEST',
                route: 'MICIN',
                createdAt: new Date(),
                partialTakeProfitAt: null,
                entryValueUsd: 3,
                solPriceAtEntry: 75,
                totalFeesSol: 0,
            },
            0.0001,
            2,
            11,
            {
                priceUsd: 0.0001,
                volScore: 0.05,
                priceChange1h: -15,
                liquidityUsd: 10000,
                marketCapUsd: 50000,
                volume5mUsd: 100,
                volume1hUsd: 10000,
                buys5mCount: 2,
                sells5mCount: 8,
                volumeSurge: 0.5,
                zScore: 0.5,
            },
        );

        expect(handled).toBe(true);
        expect(executeSell).toHaveBeenCalledWith(8, 0.0001, 'AI_HEALTH_CRITICAL');
    });
});

type MonitorPricesTestable = {
    monitorPrices: () => Promise<void>;
    processingTrades: Set<number>;
    priceMissCounts: Map<number, number>;
    lastAlertTime: Map<number, number>;
    lastRiskAdjustmentAlertTime: Map<number, number>;
    evaluateTrade: (
        trade: unknown,
        currentPrice: number,
        solPriceUsd: number,
        freshMarketSignals?: unknown,
    ) => Promise<void>;
};

describe('PriceMonitorService.monitorPrices', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    function mockDexScreenerPairs(pairs: Array<{ mint: string; priceUsd: string }>) {
        return jest.spyOn(DexLimiter, 'get').mockResolvedValue({
            data: {
                pairs: pairs.map(({ mint, priceUsd }) => ({
                    baseToken: { address: mint },
                    priceUsd,
                    liquidity: { usd: 10000 },
                    volume: { m5: 100, h1: 1200 },
                    txns: { m5: { buys: 5, sells: 2 } },
                    priceChange: { h1: 1 },
                    fdv: 50000,
                })),
            },
        } as never);
    }

    function createMonitorService(
        overrides: {
            findMany?: jest.Mock;
            getSolPrice?: jest.Mock;
            sendPriceMissAlert?: jest.Mock;
            config?: Record<string, unknown>;
        } = {},
    ) {
        const configService = {
            get: jest.fn((key: string, fallback?: unknown) =>
                overrides.config && Object.prototype.hasOwnProperty.call(overrides.config, key)
                    ? overrides.config[key]
                    : fallback,
            ),
        };
        const prismaService = {
            trade: { findMany: overrides.findMany ?? jest.fn().mockResolvedValue([]) },
        };
        const tradeService = {
            getSolPrice: overrides.getSolPrice ?? jest.fn().mockResolvedValue(150),
        };
        const telegramWorkspace = { getChatSettingsByChatDbId: jest.fn() };
        const reportingService = {
            sendPriceMissAlert: overrides.sendPriceMissAlert ?? jest.fn().mockResolvedValue(undefined),
        };

        const service = new PriceMonitorService(
            configService as never,
            prismaService as never,
            tradeService as never,
            telegramWorkspace as never,
            reportingService as never,
            {} as never,
        ) as unknown as MonitorPricesTestable;

        return { service, tradeService, reportingService };
    }

    it('skips a trade already claimed by a concurrent tick (FIX A4a: processingTrades race guard)', async () => {
        const trade = { id: 1, tokenMint: 'MINT1', slotNumber: 1, telegramChatId: null, telegramChat: null };
        const findMany = jest.fn().mockResolvedValue([trade]);
        const getSolPrice = jest.fn().mockResolvedValue(150);
        mockDexScreenerPairs([{ mint: 'MINT1', priceUsd: '1.5' }]);

        const { service, tradeService } = createMonitorService({ findMany, getSolPrice });
        const evaluateSpy = jest.spyOn(service, 'evaluateTrade').mockResolvedValue(undefined);

        // Simulate an overlapping @Interval(2000) tick already processing this trade.
        service.processingTrades.add(1);

        await service.monitorPrices();

        expect(evaluateSpy).not.toHaveBeenCalled();
        expect(tradeService.getSolPrice).not.toHaveBeenCalled();
        // The slot must remain claimed -- this tick's `continue` must not touch it.
        expect(service.processingTrades.has(1)).toBe(true);
    });

    it('re-escalates the price-miss alert every N ticks instead of firing once ever (FIX B2 + verifier re-escalation fix)', async () => {
        const trade = {
            id: 2,
            tokenMint: 'MINT_MISSING',
            symbol: 'MISS',
            slotNumber: 2,
            telegramChatId: null,
            telegramChat: null,
        };
        const findMany = jest.fn().mockResolvedValue([trade]);
        jest.spyOn(DexLimiter, 'get').mockResolvedValue({ data: { pairs: [] } } as never);
        const sendPriceMissAlert = jest.fn().mockResolvedValue(undefined);

        const { service, tradeService } = createMonitorService({
            findMany,
            sendPriceMissAlert,
            config: { PRICE_MISS_ALERT_AFTER_TICKS: '2' },
        });

        await service.monitorPrices(); // miss 1
        expect(sendPriceMissAlert).not.toHaveBeenCalled();

        await service.monitorPrices(); // miss 2 -- threshold hit
        expect(sendPriceMissAlert).toHaveBeenCalledTimes(1);
        expect(sendPriceMissAlert).toHaveBeenLastCalledWith(
            expect.objectContaining({ tokenMint: 'MINT_MISSING', misses: 2 }),
        );

        await service.monitorPrices(); // miss 3 -- no re-alert yet
        expect(sendPriceMissAlert).toHaveBeenCalledTimes(1);

        await service.monitorPrices(); // miss 4 -- re-escalates (verifier MINOR fix)
        expect(sendPriceMissAlert).toHaveBeenCalledTimes(2);
        expect(sendPriceMissAlert).toHaveBeenLastCalledWith(expect.objectContaining({ misses: 4 }));

        // verifier MAJOR: the alert must describe a stale-priced OPEN position, not a
        // failed execution -- no leftover "side"/failure-shaped fields from the old
        // sendTradeFailureAlert reuse.
        const firstCallParams = sendPriceMissAlert.mock.calls[0][0];
        expect(firstCallParams.reason).toContain('price_miss');
        expect(firstCallParams).not.toHaveProperty('side');

        // Every trade this tick was price-missing, so Jupiter should never be hit.
        expect(tradeService.getSolPrice).not.toHaveBeenCalled();
    });

    it('releases priceMissCounts once a trade leaves the OPEN snapshot (fix: unbounded Map leak)', async () => {
        const trade = {
            id: 3,
            tokenMint: 'MINT_GONE',
            slotNumber: 3,
            telegramChatId: null,
            telegramChat: null,
        };
        const findMany = jest
            .fn()
            .mockResolvedValueOnce([trade]) // tick 1: OPEN, price missing
            .mockResolvedValueOnce([]); // tick 2: sold/closed elsewhere -- no longer OPEN
        jest.spyOn(DexLimiter, 'get').mockResolvedValue({ data: { pairs: [] } } as never);

        const { service } = createMonitorService({ findMany });

        await service.monitorPrices();
        expect(service.priceMissCounts.get(3)).toBe(1);

        await service.monitorPrices();
        expect(service.priceMissCounts.has(3)).toBe(false);
    });

    // Verifier MAJOR fix: lastAlertTime/lastRiskAdjustmentAlertTime were re-keyed from
    // tokenMint to trade.id but had zero prune/delete coverage -- every closed trade left a
    // permanent dead entry (unbounded memory leak). Assert both maps are pruned the same way
    // priceMissCounts/dynamicHoldZoneEnteredAt already are.
    it('releases lastAlertTime and lastRiskAdjustmentAlertTime once a trade leaves the OPEN snapshot (fix: unbounded Map leak)', async () => {
        const trade = {
            id: 4,
            tokenMint: 'MINT_CLOSED',
            slotNumber: 4,
            telegramChatId: null,
            telegramChat: null,
        };
        const findMany = jest
            .fn()
            .mockResolvedValueOnce([trade]) // tick 1: still OPEN
            .mockResolvedValueOnce([]); // tick 2: sold/closed elsewhere -- no longer OPEN
        jest.spyOn(DexLimiter, 'get').mockResolvedValue({ data: { pairs: [] } } as never);

        const { service } = createMonitorService({ findMany });
        service.lastAlertTime.set(trade.id, Date.now());
        service.lastRiskAdjustmentAlertTime.set(trade.id, Date.now());

        await service.monitorPrices();
        expect(service.lastAlertTime.has(trade.id)).toBe(true);
        expect(service.lastRiskAdjustmentAlertTime.has(trade.id)).toBe(true);

        await service.monitorPrices();
        expect(service.lastAlertTime.has(trade.id)).toBe(false);
        expect(service.lastRiskAdjustmentAlertTime.has(trade.id)).toBe(false);
    });

    // Verifier MINOR fix: no coverage existed for PRICE_MONITOR_CONCURRENCY_LIMIT actually
    // bounding per-tick concurrency.
    it('bounds per-tick concurrency to PRICE_MONITOR_CONCURRENCY_LIMIT (FIX A4b)', async () => {
        const trades = [1, 2, 3, 4, 5].map((id) => ({
            id,
            tokenMint: `MINT_${id}`,
            slotNumber: id,
            telegramChatId: null,
            telegramChat: null,
        }));
        const findMany = jest.fn().mockResolvedValue(trades);
        mockDexScreenerPairs(trades.map((t) => ({ mint: t.tokenMint, priceUsd: '1.5' })));

        const { service } = createMonitorService({
            findMany,
            config: { PRICE_MONITOR_CONCURRENCY_LIMIT: '2' },
        });

        let inFlight = 0;
        let maxInFlight = 0;
        const evaluateSpy = jest.spyOn(service, 'evaluateTrade').mockImplementation(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 10));
            inFlight--;
        });

        await service.monitorPrices();

        expect(evaluateSpy).toHaveBeenCalledTimes(5);
        expect(maxInFlight).toBeGreaterThan(1); // proves it runs concurrently, not serially
        expect(maxInFlight).toBeLessThanOrEqual(2); // proves concurrency is capped at the limit
    });

    it('fetches SOL/USD at most once per tick across multiple trades (FIX B3 hoisting)', async () => {
        const tradeA = { id: 10, tokenMint: 'MINT_A', slotNumber: 10, telegramChatId: null, telegramChat: null };
        const tradeB = { id: 11, tokenMint: 'MINT_B', slotNumber: 11, telegramChatId: null, telegramChat: null };
        const findMany = jest.fn().mockResolvedValue([tradeA, tradeB]);
        const getSolPrice = jest.fn().mockResolvedValue(150);
        mockDexScreenerPairs([
            { mint: 'MINT_A', priceUsd: '1.5' },
            { mint: 'MINT_B', priceUsd: '2.5' },
        ]);

        const { service, tradeService } = createMonitorService({ findMany, getSolPrice });
        const evaluateSpy = jest.spyOn(service, 'evaluateTrade').mockResolvedValue(undefined);

        await service.monitorPrices();

        expect(tradeService.getSolPrice).toHaveBeenCalledTimes(1);
        expect(evaluateSpy).toHaveBeenCalledTimes(2);
        expect(evaluateSpy.mock.calls[0][2]).toBe(150);
        expect(evaluateSpy.mock.calls[1][2]).toBe(150);
    });

    it('never fetches SOL/USD when every trade this tick is price-missing (nitpick fix: no unconditional per-tick call)', async () => {
        const trade = { id: 12, tokenMint: 'MINT_MISS', slotNumber: 12, telegramChatId: null, telegramChat: null };
        const findMany = jest.fn().mockResolvedValue([trade]);
        const getSolPrice = jest.fn().mockResolvedValue(150);
        jest.spyOn(DexLimiter, 'get').mockResolvedValue({ data: { pairs: [] } } as never);

        const { service, tradeService } = createMonitorService({ findMany, getSolPrice });

        await service.monitorPrices();

        expect(tradeService.getSolPrice).not.toHaveBeenCalled();
    });
});

type EvaluateTradeTestable = {
    evaluateTrade: (
        trade: unknown,
        currentPrice: number,
        solPriceUsd: number,
        freshMarketSignals?: unknown,
    ) => Promise<void>;
    dynamicHoldZoneEnteredAt: Map<number, number>;
};

// Verifier MAJOR fix: FIX C1's dynamic-hold-zone forced-exit-on-timeout path had zero
// automated coverage. These tests exercise it directly through evaluateTrade.
describe('PriceMonitorService dynamic hold zone (FIX C1) forced exit on timeout', () => {
    function createZoneService(
        overrides: {
            config?: Record<string, unknown>;
            evaluateTokenHealth?: jest.Mock;
        } = {},
    ) {
        const configService = {
            get: jest.fn((key: string, fallback?: unknown) =>
                overrides.config && Object.prototype.hasOwnProperty.call(overrides.config, key)
                    ? overrides.config[key]
                    : fallback,
            ),
        };
        const prismaService = {
            watchlist: { findUnique: jest.fn().mockResolvedValue(null) },
        };
        const executeSell = jest.fn().mockResolvedValue(true);
        const tradeService = { executeSell };
        const evaluateTokenHealth =
            overrides.evaluateTokenHealth ??
            jest.fn().mockResolvedValue({
                status: 'HEALTHY',
                confidenceLevel: 'high',
                reasoning: 'ok',
                reentrySignal: true,
            });
        const aiService = {
            getRecommendedTrailingDistance: jest.fn().mockReturnValue(999),
            evaluateTokenHealth,
        };

        const service = new PriceMonitorService(
            configService as never,
            prismaService as never,
            tradeService as never,
            {} as never,
            {} as never,
            aiService as never,
        ) as unknown as EvaluateTradeTestable;

        return { service, executeSell, evaluateTokenHealth };
    }

    // -15% gross vs. a 20% effective stop loss: inside the dynamic hold zone
    // (between -10% = half of SL, and -20% = SL) for every test in this block.
    function makeZoneTrade(overrides: Record<string, unknown> = {}) {
        const now = Date.now();
        return {
            id: 100,
            slotNumber: 1,
            tokenMint: 'MINT_ZONE',
            symbol: 'ZONE',
            route: 'GLOBAL',
            targetStopLoss: 20,
            targetTrailingDistance: null,
            targetTakeProfit: null,
            partialTakeProfitAt: null,
            entryPrice: 0.00002,
            highestPrice: 0.00002,
            trailingStopPrice: 0,
            solPriceAtEntry: 100,
            entryValueUsd: 3,
            totalFeesSol: 0,
            createdAt: new Date(now - 120_000),
            creatorAddress: null,
            topHolderAddress: null,
            initialCreatorBalance: null,
            initialTopHolderBalance: null,
            slTriggeredAt: null,
            telegramChat: null,
            ...overrides,
        };
    }

    const zoneSignals = {
        priceUsd: 0.0017,
        volScore: 0,
        priceChange1h: 0,
        liquidityUsd: 10000,
        marketCapUsd: 50000,
        volume5mUsd: 0,
        volume1hUsd: 0,
        buys5mCount: 0,
        sells5mCount: 0,
        volumeSurge: 0,
        zScore: 0,
    };
    const zoneConfig = {
        ENABLE_DYNAMIC_HOLD_ZONE: true,
        DYNAMIC_HOLD_ZONE_MAX_SECONDS: 60,
        MIN_NON_CRITICAL_HOLD_SECONDS: 90,
    };

    it('marks the zone as entered on first tick without forcing an exit', async () => {
        const { service, executeSell, evaluateTokenHealth } = createZoneService({ config: zoneConfig });
        const trade = makeZoneTrade();

        await service.evaluateTrade(trade, 0.0017, 100, zoneSignals);

        expect(service.dynamicHoldZoneEnteredAt.has(trade.id)).toBe(true);
        expect(executeSell).not.toHaveBeenCalled();
        expect(evaluateTokenHealth).toHaveBeenCalledTimes(1);
    });

    it('force-exits with a distinct exitReason once the zone max duration elapses, bypassing the AI health check', async () => {
        const { service, executeSell, evaluateTokenHealth } = createZoneService({ config: zoneConfig });
        // Trade is well past MIN_NON_CRITICAL_HOLD_SECONDS (90s), isolating the zone-timeout
        // behavior from the min-hold gate exercised in the next test.
        const trade = makeZoneTrade({ createdAt: new Date(Date.now() - 120_000) });
        // Zone entered 90s ago -- past the 60s max duration.
        service.dynamicHoldZoneEnteredAt.set(trade.id, Date.now() - 90_000);

        await service.evaluateTrade(trade, 0.0017, 100, zoneSignals);

        expect(executeSell).toHaveBeenCalledWith(trade.id, 0.0017, 'STOP_LOSS_ZONE_TIMEOUT');
        // Bypasses the AI health check entirely -- forced regardless of AI health.
        expect(evaluateTokenHealth).not.toHaveBeenCalled();
        expect(service.dynamicHoldZoneEnteredAt.has(trade.id)).toBe(false);
    });

    it('does not force-exit on zone timeout before the overall min-hold window has elapsed (verifier fix)', async () => {
        const { service, executeSell, evaluateTokenHealth } = createZoneService({ config: zoneConfig });
        // Trade is only 10s old -- well inside MIN_NON_CRITICAL_HOLD_SECONDS (90s).
        const trade = makeZoneTrade({ createdAt: new Date(Date.now() - 10_000) });
        // Zone entered 90s ago -- past DYNAMIC_HOLD_ZONE_MAX_SECONDS (60s) in isolation, but
        // that alone must no longer be sufficient to force the exit.
        service.dynamicHoldZoneEnteredAt.set(trade.id, Date.now() - 90_000);

        await service.evaluateTrade(trade, 0.0017, 100, zoneSignals);

        expect(executeSell).not.toHaveBeenCalled();
        // Falls through to the normal AI health check instead of an unconditional bypass.
        expect(evaluateTokenHealth).toHaveBeenCalledTimes(1);
    });
});

type TrailingAlertTestable = {
    evaluateTrade: (
        trade: unknown,
        currentPrice: number,
        solPriceUsd: number,
        freshMarketSignals?: unknown,
    ) => Promise<void>;
    lastAlertTime: Map<number, number>;
};

// Verifier MAJOR fix: lastAlertTime is now keyed by trade.id instead of tokenMint, since two
// different chats can each hold their own OPEN LIVE trade on the same tokenMint. These tests
// exercise that re-keying directly through evaluateTrade's trailing-alert path -- the exact
// multi-chat-same-mint cooldown race the fix addresses had zero prior coverage.
describe('PriceMonitorService trailing alert cooldown (trade.id re-keying, verifier MINOR: test coverage)', () => {
    function createTrailingAlertService(config: Record<string, unknown> = {}) {
        const configService = {
            get: jest.fn((key: string, fallback?: unknown) =>
                Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback,
            ),
        };
        const prismaService = {
            trade: { update: jest.fn().mockResolvedValue({}) },
            watchlist: { findUnique: jest.fn().mockResolvedValue(null) },
        };
        const executeSell = jest.fn();
        const tradeService = { executeSell, getSolPrice: jest.fn().mockResolvedValue(100) };
        const sendTrailingAlert = jest.fn().mockResolvedValue(undefined);
        const sendRiskAdjustmentAlert = jest.fn().mockResolvedValue(undefined);
        const reportingService = { sendTrailingAlert, sendRiskAdjustmentAlert };
        const aiService = {
            getRecommendedTrailingDistance: jest.fn().mockReturnValue(999),
            evaluateTokenHealth: jest.fn(),
        };

        const service = new PriceMonitorService(
            configService as never,
            prismaService as never,
            tradeService as never,
            {} as never,
            reportingService as never,
            aiService as never,
        ) as unknown as TrailingAlertTestable;

        return { service, executeSell, sendTrailingAlert };
    }

    // 10% profit: above the 8% default trailing-activation threshold and a new peak, but
    // below 15% so the break-even-floor branch (which needs entryValueUsd/solPriceAtEntry)
    // never engages -- isolates the alert-cooldown path being tested.
    function makeTrailingTrade(overrides: Record<string, unknown> = {}) {
        return {
            id: 501,
            slotNumber: 1,
            tokenMint: 'MINT_SHARED',
            symbol: 'SHARED',
            route: 'GLOBAL',
            targetStopLoss: null,
            targetTrailingDistance: null,
            targetTakeProfit: null,
            partialTakeProfitAt: null,
            entryPrice: 0.00002,
            highestPrice: 0.00002,
            trailingStopPrice: 0,
            solPriceAtEntry: 100,
            createdAt: new Date(Date.now() - 120_000),
            creatorAddress: null,
            topHolderAddress: null,
            initialCreatorBalance: null,
            initialTopHolderBalance: null,
            slTriggeredAt: null,
            telegramChat: null,
            ...overrides,
        };
    }

    const trailingSignals = {
        priceUsd: 0.0022,
        volScore: 0,
        priceChange1h: 0,
        liquidityUsd: 10000,
        marketCapUsd: 50000,
        volume5mUsd: 0,
        volume1hUsd: 0,
        buys5mCount: 0,
        sells5mCount: 0,
        volumeSurge: 0,
        zScore: 0,
    };
    // currentPriceSol = 0.0022 / 100 = 0.000022 -> 10% above entryPrice (0.00002).
    const CURRENT_PRICE_USD = 0.0022;
    const CURRENT_SOL_USD = 100;

    it('does not let one trade.id cooldown suppress the trailing alert for a different trade on the same tokenMint', async () => {
        const { service, executeSell, sendTrailingAlert } = createTrailingAlertService();
        const tradeA = makeTrailingTrade({ id: 501 });
        const tradeB = makeTrailingTrade({ id: 502 });

        await service.evaluateTrade(tradeA, CURRENT_PRICE_USD, CURRENT_SOL_USD, trailingSignals);
        await service.evaluateTrade(tradeB, CURRENT_PRICE_USD, CURRENT_SOL_USD, trailingSignals);

        expect(executeSell).not.toHaveBeenCalled();
        // Both trades share tokenMint 'MINT_SHARED' but have distinct trade.id -- a tokenMint-keyed
        // cooldown would have suppressed the second alert entirely (the bug this fix addresses).
        expect(sendTrailingAlert).toHaveBeenCalledTimes(2);
        expect(service.lastAlertTime.has(501)).toBe(true);
        expect(service.lastAlertTime.has(502)).toBe(true);
    });

    it('still cools down repeat trailing alerts for the same trade.id within the 5-minute window', async () => {
        const { service, sendTrailingAlert } = createTrailingAlertService();
        const trade = makeTrailingTrade({ id: 501 });

        await service.evaluateTrade(trade, CURRENT_PRICE_USD, CURRENT_SOL_USD, trailingSignals);
        expect(sendTrailingAlert).toHaveBeenCalledTimes(1);

        // Same trade, immediately again (well inside the 5-minute cooldown window).
        await service.evaluateTrade(trade, CURRENT_PRICE_USD, CURRENT_SOL_USD, trailingSignals);
        expect(sendTrailingAlert).toHaveBeenCalledTimes(1);
    });
});

