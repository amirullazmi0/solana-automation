import {
    isWithdrawalsEnabled,
    isWithdrawChatAllowed,
    parseChatIdList,
    validateWithdrawAccess,
} from '../common/withdraw-guard';

describe('withdraw guard helpers', () => {
    it('denies withdraw when chat id is not in allowlist', () => {
        expect(isWithdrawChatAllowed('999', ['123', '456'])).toBe(false);
    });

    it('allows withdraw only for exact whitelisted chat id', () => {
        expect(isWithdrawChatAllowed('123', ['123', '456'])).toBe(true);
        expect(isWithdrawChatAllowed('12', ['123'])).toBe(false);
    });

    it('parses chat id allowlist safely', () => {
        expect(parseChatIdList('123, 456,123,,')).toEqual(['123', '456']);
    });

    it('keeps withdrawals disabled unless explicitly enabled', () => {
        expect(isWithdrawalsEnabled(undefined)).toBe(false);
        expect(isWithdrawalsEnabled('false')).toBe(false);
        expect(isWithdrawalsEnabled('true')).toBe(true);
        expect(isWithdrawalsEnabled('1')).toBe(true);
    });

    it('requires enabled withdrawals, allowlisted chat, and connected wallet', () => {
        expect(
            validateWithdrawAccess({
                chatId: '123',
                withdrawalsEnabled: false,
                allowedChatIds: ['123'],
                walletPublicKey: 'wallet',
            }),
        ).toEqual({ allowed: false, reason: 'withdrawals_disabled' });

        expect(
            validateWithdrawAccess({
                chatId: '999',
                withdrawalsEnabled: true,
                allowedChatIds: ['123'],
                walletPublicKey: 'wallet',
            }),
        ).toEqual({ allowed: false, reason: 'chat_not_allowed' });

        expect(
            validateWithdrawAccess({
                chatId: '123',
                withdrawalsEnabled: true,
                allowedChatIds: ['123'],
            }),
        ).toEqual({ allowed: false, reason: 'wallet_not_connected' });
    });

    it('rejects signer wallet mismatch for a chat wallet', () => {
        expect(
            validateWithdrawAccess({
                chatId: '123',
                withdrawalsEnabled: true,
                allowedChatIds: ['123'],
                walletPublicKey: 'wallet-a',
                signerPublicKey: 'wallet-b',
            }),
        ).toEqual({ allowed: false, reason: 'wallet_mismatch' });

        expect(
            validateWithdrawAccess({
                chatId: '123',
                withdrawalsEnabled: true,
                allowedChatIds: ['123'],
                walletPublicKey: 'wallet-a',
                signerPublicKey: 'wallet-a',
            }),
        ).toEqual({ allowed: true });
    });
});