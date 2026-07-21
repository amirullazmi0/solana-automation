import { parseRuntimeConfigText, validateConfig } from './runtime-config';

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
});
