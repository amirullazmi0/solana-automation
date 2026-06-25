import { validateConfig } from './runtime-config';

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
});
