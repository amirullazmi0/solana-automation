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
});