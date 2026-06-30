import { isWithdrawChatAllowed } from './reporting.service';

describe('withdraw chat allowlist helper', () => {
    it('denies withdraw when chat id is not in allowlist', () => {
        expect(isWithdrawChatAllowed('999', ['123', '456'])).toBe(false);
    });

    it('allows withdraw only for exact whitelisted chat id', () => {
        expect(isWithdrawChatAllowed('123', ['123', '456'])).toBe(true);
        expect(isWithdrawChatAllowed('12', ['123'])).toBe(false);
    });
});
