import { RugCheckMarket } from '../dto/analyzer.dto';
import { DEFAULT_MIN_LP_LOCKED_PCT, isLpSafe, isMarketLpSafe, maxLpLockedPct } from './lp-safety';

describe('lp-safety', () => {
    // Shape captured from a live RugCheck v1 report (pump_fun_amm market).
    const lockedMarket: RugCheckMarket = {
        pubkey: 'eW32AjEwxBML3b7B9HJFKBvxWNpzDZpeZgeDqeZyhGu',
        marketType: 'pump_fun_amm',
        lp: { lpLocked: 4193388285344, lpLockedPct: 100, lpTotalSupply: 4193388285344 },
    };
    const unlockedMarket: RugCheckMarket = {
        marketType: 'meteora_damm_v2',
        lp: { lpLocked: 0, lpLockedPct: 0, lpTotalSupply: 0 },
    };

    it('accepts a market whose LP is fully locked via lp.lpLockedPct', () => {
        expect(isMarketLpSafe(lockedMarket)).toBe(true);
    });

    it('rejects a market whose LP is unlocked', () => {
        expect(isMarketLpSafe(unlockedMarket)).toBe(false);
    });

    it('still honours the legacy flat lpType/lpStatus strings', () => {
        expect(isMarketLpSafe({ lpType: 'burned' })).toBe(true);
        expect(isMarketLpSafe({ lpStatus: 'locked' })).toBe(true);
        expect(isMarketLpSafe({ lpType: 'open' })).toBe(false);
    });

    it('treats a market with neither the legacy flags nor lp data as unsafe', () => {
        expect(isMarketLpSafe({ marketType: 'pump_fun_amm' })).toBe(false);
        expect(isMarketLpSafe(undefined)).toBe(false);
    });

    it('passes the token when at least one market is locked', () => {
        expect(isLpSafe([unlockedMarket, lockedMarket])).toBe(true);
    });

    it('fails the token when no market is locked', () => {
        expect(isLpSafe([unlockedMarket])).toBe(false);
        expect(isLpSafe([])).toBe(false);
        expect(isLpSafe(undefined)).toBe(false);
    });

    it('respects a custom minimum lock percentage', () => {
        const partiallyLocked: RugCheckMarket = { lp: { lpLockedPct: 85 } };
        expect(isLpSafe([partiallyLocked], 90)).toBe(false);
        expect(isLpSafe([partiallyLocked], 80)).toBe(true);
    });

    it('defaults the minimum lock percentage to 90', () => {
        expect(DEFAULT_MIN_LP_LOCKED_PCT).toBe(90);
        expect(isLpSafe([{ lp: { lpLockedPct: 89.9 } }])).toBe(false);
        expect(isLpSafe([{ lp: { lpLockedPct: 90 } }])).toBe(true);
    });

    it('reports the highest lock percentage across markets', () => {
        expect(maxLpLockedPct([unlockedMarket, lockedMarket])).toBe(100);
        expect(maxLpLockedPct([])).toBe(0);
        expect(maxLpLockedPct([{ marketType: 'x' }])).toBe(0);
    });
});
