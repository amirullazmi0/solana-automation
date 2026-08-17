import { loadRuntimeConfig, parseRuntimeConfigText, validateConfig } from './runtime-config';

const validConfig = {
    TOTAL_CAPITAL: 25,
    RESERVE_AMOUNT: 10,
    POSITION_SIZE_USD: 3,
    TOTAL_SLOTS: 2,
    STOP_LOSS_PERCENT: 12,
    TRAILING_DISTANCE_PERCENT: 1.5,
    MIN_MCAP: 5000,
    MAX_MCAP: 3000000,
};

describe('validateConfig', () => {
    it('parses config files that contain a UTF-8 BOM', () => {
        expect(parseRuntimeConfigText('\uFEFF{"STOP_LOSS_PERCENT":12}')).toEqual({
            STOP_LOSS_PERCENT: 12,
        });
    });

    it('accepts valid trading config', () => {
        expect(validateConfig(validConfig)).toEqual([]);
    });

    it('rejects insufficient capital coverage', () => {
        const errors = validateConfig({
            ...validConfig,
            TOTAL_CAPITAL: 10,
            RESERVE_AMOUNT: 8,
        });
        expect(errors.join(' ')).toContain('Capital coverage invalid');
    });

    it('rejects invalid stop loss, trailing, and mcap range', () => {
        const errors = validateConfig({
            ...validConfig,
            STOP_LOSS_PERCENT: 0,
            TRAILING_DISTANCE_PERCENT: 0,
            MIN_MCAP: 100,
            MAX_MCAP: 100,
        });
        expect(errors).toContain('STOP_LOSS_PERCENT must be greater than 0.');
        expect(errors).toContain('TRAILING_DISTANCE_PERCENT must be greater than 0.');
        expect(errors).toContain('MIN_MCAP must be lower than MAX_MCAP.');
    });

    it('rejects unsafe holder, liquidity, whale, and probe thresholds', () => {
        const errors = validateConfig({
            ...validConfig,
            MAX_SINGLE_HOLDER_PCT: 30,
            MAX_TOP5_HOLDER_PCT: 20,
            MAX_TOP10_HOLDER_PCT: 10,
            LIQUIDITY_DROP_WARN_PERCENT: 60,
            LIQUIDITY_DROP_EXIT_PERCENT: 30,
            LIQUIDITY_DROP_PANIC_PERCENT: 20,
            WHALE_DUMP_THRESHOLD_PERCENT: 60,
            WHALE_DUMP_PANIC_PERCENT: 40,
            HONEYPOT_PROBE_MIN_POSITION_USD: 0.25,
            HONEYPOT_PROBE_USD: 0.5,
        });

        expect(errors.join(' ')).toContain('Holder limits');
        expect(errors.join(' ')).toContain('Liquidity thresholds');
        expect(errors.join(' ')).toContain('Whale thresholds');
        expect(errors.join(' ')).toContain('HONEYPOT_PROBE_USD');
    });

    it('rejects an unsafe short-term momentum floor', () => {
        const errors = validateConfig({
            ...validConfig,
            MIN_PRICE_CHANGE_5M_PCT: -5.1,
        });

        expect(errors).toContain('MIN_PRICE_CHANGE_5M_PCT must be between -5 and 100.');
    });

    it('rejects invalid aggressive rebound, holder, and DEX-pair retry settings', () => {
        const errors = validateConfig({
            ...validConfig,
            BEARISH_REBOUND_1H_FLOOR_PCT: -10,
            BEARISH_REBOUND_MIN_5M_PCT: -1,
            AGGRESSIVE_HOLDER_MIN_LIQUIDITY_USD: -1,
            AGGRESSIVE_MAX_SINGLE_HOLDER_PCT: 30,
            AGGRESSIVE_MAX_TOP5_HOLDER_PCT: 20,
            AGGRESSIVE_MAX_TOP10_HOLDER_PCT: 10,
            AGGRESSIVE_RUGCHECK_MIN_SAFETY_INDEX: 1.1,
            ZERO_LIQUIDITY_MAX_RECHECKS: 0,
            NO_DEX_PAIR_MAX_RETRIES: 0,
            NO_DEX_PAIR_RETRY_BASE_MS: 99,
        });

        expect(errors.join(' ')).toContain('BEARISH_REBOUND_1H_FLOOR_PCT');
        expect(errors.join(' ')).toContain('BEARISH_REBOUND_MIN_5M_PCT');
        expect(errors.join(' ')).toContain('AGGRESSIVE_HOLDER_MIN_LIQUIDITY_USD');
        expect(errors.join(' ')).toContain('Aggressive holder limits');
        expect(errors.join(' ')).toContain('AGGRESSIVE_RUGCHECK_MIN_SAFETY_INDEX');
        expect(errors.join(' ')).toContain('ZERO_LIQUIDITY_MAX_RECHECKS');
        expect(errors.join(' ')).toContain('NO_DEX_PAIR_MAX_RETRIES');
        expect(errors.join(' ')).toContain('NO_DEX_PAIR_RETRY_BASE_MS');
    });
});

describe('zero-liquidity active retry settings', () => {
    const base = { ...loadRuntimeConfig() };

    it('accepts the shipped configuration', () => {
        expect(validateConfig(base)).toEqual([]);
    });

    it('rejects a non-integer or zero retry count', () => {
        expect(validateConfig({ ...base, ZERO_LIQUIDITY_MAX_RETRIES: 0 })).toContain(
            'ZERO_LIQUIDITY_MAX_RETRIES must be an integer >= 1.',
        );
        expect(validateConfig({ ...base, ZERO_LIQUIDITY_MAX_RETRIES: 2.5 })).toContain(
            'ZERO_LIQUIDITY_MAX_RETRIES must be an integer >= 1.',
        );
    });

    it('rejects a base backoff that would hammer DexScreener', () => {
        expect(validateConfig({ ...base, ZERO_LIQUIDITY_RETRY_BASE_MS: 100 })).toContain(
            'ZERO_LIQUIDITY_RETRY_BASE_MS must be an integer >= 500.',
        );
    });

    it('rejects a negative active-retry age window', () => {
        expect(validateConfig({ ...base, ZERO_LIQUIDITY_ACTIVE_RETRY_MAX_AGE_MIN: -1 })).toContain(
            'ZERO_LIQUIDITY_ACTIVE_RETRY_MAX_AGE_MIN must be >= 0.',
        );
    });
});

describe('h1 flow gate validation', () => {
    // These are shares (0.6 = 60%), so a bare "60" would reject every token silently.
    it('rejects a share expressed as a percentage', () => {
        expect(validateConfig({ ...validConfig, MIN_H1_BUY_SHARE: 60 })).toContain(
            'MIN_H1_BUY_SHARE must be a share between 0 and 1 (0 disables the gate).',
        );
        expect(validateConfig({ ...validConfig, MIN_H1_BUY_VOLUME_SHARE: 55 })).toContain(
            'MIN_H1_BUY_VOLUME_SHARE must be a share between 0 and 1 (0 disables the gate).',
        );
    });

    it('accepts valid shares and a zero that disables the gate', () => {
        expect(validateConfig({ ...validConfig, MIN_H1_BUY_SHARE: 0.6 })).toEqual([]);
        expect(validateConfig({ ...validConfig, MIN_H1_BUY_SHARE: 0 })).toEqual([]);
    });

    it('requires at least one page of Helius history', () => {
        expect(validateConfig({ ...validConfig, HELIUS_FLOW_MAX_PAGES: 0 })).toContain(
            'HELIUS_FLOW_MAX_PAGES must be an integer >= 1.',
        );
    });
});
