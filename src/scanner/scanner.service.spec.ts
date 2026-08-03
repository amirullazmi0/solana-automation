import {
    EntryConfirmationConfig,
    EntryConfirmationSnapshot,
    ScannerService,
    evaluateEntryConfirmation,
    getPumpPortalDiscoverySubscriptions,
} from './scanner.service';

describe('PumpPortal discovery subscription', () => {
    it('uses the current migration stream method', () => {
        expect(getPumpPortalDiscoverySubscriptions()).toEqual([{ method: 'subscribeMigration' }]);
    });
});

describe('evaluateEntryConfirmation', () => {
    const config: EntryConfirmationConfig = {
        windowMs: 4000,
        maxDropPct: 1,
        maxChasePct: 8,
        minLiquidityRatio: 0.97,
        minNewBuys: 5,
        buySellRatio: 1.25,
    };
    const baseline: EntryConfirmationSnapshot = {
        startedAt: 1000,
        priceUsd: 100,
        liquidityUsd: 10000,
        buys5m: 100,
        sells5m: 50,
    };

    it('waits for the complete observation window', () => {
        expect(
            evaluateEntryConfirmation(
                baseline,
                { priceUsd: 101, liquidityUsd: 10000, buys5m: 110, sells5m: 52 },
                4999,
                config,
            ),
        ).toEqual({ decision: 'PENDING', reason: 'entry_confirmation_pending' });
    });

    it('passes sustained price, liquidity, and buyer growth', () => {
        expect(
            evaluateEntryConfirmation(
                baseline,
                { priceUsd: 104, liquidityUsd: 9900, buys5m: 110, sells5m: 52 },
                5000,
                config,
            ),
        ).toEqual({ decision: 'PASS', reason: 'entry_confirmation_passed' });
    });

    it('accepts an exact 60:40 share of new buys and sells', () => {
        const strictConfig = { ...config, buySellRatio: 1.5 };
        expect(
            evaluateEntryConfirmation(
                baseline,
                { priceUsd: 101, liquidityUsd: 10000, buys5m: 106, sells5m: 54 },
                5000,
                strictConfig,
            ),
        ).toEqual({ decision: 'PASS', reason: 'entry_confirmation_passed' });
        expect(
            evaluateEntryConfirmation(
                baseline,
                { priceUsd: 101, liquidityUsd: 10000, buys5m: 105, sells5m: 54 },
                5000,
                strictConfig,
            ),
        ).toEqual({ decision: 'RESET', reason: 'entry_confirmation_buyers_weak' });
    });

    it('accepts one fresh buy with no fresh sell after a longer feed window', () => {
        const feedTolerantConfig = {
            ...config,
            windowMs: 6000,
            minNewBuys: 1,
            buySellRatio: 1.5,
        };
        expect(
            evaluateEntryConfirmation(
                baseline,
                { priceUsd: 101, liquidityUsd: 10000, buys5m: 101, sells5m: 50 },
                7000,
                feedTolerantConfig,
            ),
        ).toEqual({ decision: 'PASS', reason: 'entry_confirmation_passed' });
    });

    it('supports a 3000ms confirmation window', () => {
        const fastConfig = { ...config, windowMs: 3000 };
        const current = {
            priceUsd: 101,
            liquidityUsd: 10000,
            buys5m: 110,
            sells5m: 52,
        };
        expect(evaluateEntryConfirmation(baseline, current, 3999, fastConfig)).toEqual({
            decision: 'PENDING',
            reason: 'entry_confirmation_pending',
        });
        expect(evaluateEntryConfirmation(baseline, current, 4000, fastConfig)).toEqual({
            decision: 'PASS',
            reason: 'entry_confirmation_passed',
        });
    });

    it.each([
        [
            { priceUsd: 98.9, liquidityUsd: 10000, buys5m: 110, sells5m: 52 },
            'entry_confirmation_price_drop',
        ],
        [
            { priceUsd: 108.1, liquidityUsd: 10000, buys5m: 110, sells5m: 52 },
            'entry_confirmation_price_chase',
        ],
        [
            { priceUsd: 101, liquidityUsd: 9699, buys5m: 110, sells5m: 52 },
            'entry_confirmation_liquidity_drop',
        ],
        [
            { priceUsd: 101, liquidityUsd: 10000, buys5m: 104, sells5m: 51 },
            'entry_confirmation_buyers_weak',
        ],
        [
            { priceUsd: 101, liquidityUsd: 10000, buys5m: 99, sells5m: 49 },
            'entry_confirmation_window_reset',
        ],
    ])('resets an unsafe confirmation snapshot', (current, reason) => {
        expect(evaluateEntryConfirmation(baseline, current, 5000, config)).toEqual({
            decision: 'RESET',
            reason,
        });
    });
});

describe('scanner health telemetry', () => {
    it('exposes qualified candidates and live buy counters', () => {
        const scanner = new ScannerService(
            { get: jest.fn((_key: string, fallback?: string | number) => fallback) } as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
        );

        expect(scanner.getScannerStatus().discovery).toEqual(
            expect.objectContaining({
                qualifiedCandidates: 0,
                liveBuyAttempts: 0,
                liveBuySuccesses: 0,
            }),
        );
    });
});