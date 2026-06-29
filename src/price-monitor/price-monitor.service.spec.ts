import { PriceMonitorService } from './price-monitor.service';

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

        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'STOP_LOSS', now)).toBe(true);
        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'TRAILING_STOP', now)).toBe(true);
    });

    it('allows non-critical exits after the minimum hold window', () => {
        const service = createService({ MIN_NON_CRITICAL_HOLD_SECONDS: 60 });
        const now = Date.now();
        const trade = { createdAt: new Date(now - 61_000) };

        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'STOP_LOSS', now)).toBe(false);
    });

    it('does not guard emergency exits', () => {
        const service = createService({ MIN_NON_CRITICAL_HOLD_SECONDS: 60 });
        const now = Date.now();
        const trade = { createdAt: new Date(now - 10_000) };

        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'PANIC_SELL', now)).toBe(false);
        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'DEV_DUMP', now)).toBe(false);
        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'RUGPULL', now)).toBe(false);
    });

    it('respects config switches for guard and health checks', () => {
        const service = createService({
            ENABLE_CONSERVATIVE_EXIT_GUARD: false,
            HEALTH_CHECK_BEFORE_EARLY_SL: false,
            HEALTH_CHECK_BEFORE_EARLY_TRAILING: true,
        });
        const now = Date.now();
        const trade = { createdAt: new Date(now - 10_000) };

        expect(service.shouldGuardEarlyNonCriticalExit(trade, 'STOP_LOSS', now)).toBe(false);
        expect(service.shouldRunEarlyExitHealthCheck('STOP_LOSS')).toBe(false);
        expect(service.shouldRunEarlyExitHealthCheck('TRAILING_STOP')).toBe(true);
    });
    it('estimates net profit after buy and sell fee drag (incl. DEX/slippage)', () => {
        const service = createService({
            USE_JITO: true,
            JITO_TIP_SOL: 0.001,
            DEX_FEE_ROUNDTRIP_PERCENT: 1.0,
        });

        const netProfit = service.estimateNetProfitPercent(
            { entryValueUsd: 3, solPriceAtEntry: 75, totalFeesSol: 0.001 },
            8,
        );

        // gross 8% - tip/network drag ((0.001 + 0.001 + 0.00001) * 75 / 3 * 100 = 5.025)
        //          - DEX/slippage allowance (1.0) = 1.975
        expect(netProfit).toBeCloseTo(1.975, 2);
    });

    it('excludes the sell Jito tip from fee drag for sub-threshold (<$3) positions', () => {
        const service = createService({
            USE_JITO: true,
            JITO_TIP_SOL: 0.001,
            JITO_MIN_POSITION_USD: 3,
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

