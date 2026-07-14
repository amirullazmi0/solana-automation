import {
    EntryConfirmationConfig,
    EntryConfirmationSnapshot,
    evaluateEntryConfirmation,
} from './scanner.service';

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
