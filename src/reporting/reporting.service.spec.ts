import {
    isWithdrawalsEnabled,
    isWithdrawChatAllowed,
    parseChatIdList,
    validateWithdrawAccess,
} from '../common/withdraw-guard';
import { buildStartupUpdateAnnouncement, ReportingService } from './reporting.service';

describe('startup update announcement', () => {
    it('builds a complete English update message with working menu actions', () => {
        const announcement = buildStartupUpdateAnnouncement();

        expect(announcement.message).toContain('MSOULMATION NOW TRADES THE META');
        expect(announcement.message).toContain('Meta detection');
        expect(announcement.message).toContain('Rising metas get priority');
        expect(announcement.message).toContain('Losing metas get pushed down');
        // The command has to be discoverable from the broadcast: it is the only place most chats
        // will ever be told the leaderboard exists.
        expect(announcement.message).toContain('/meta');
        // Kept deliberately across releases so a deploy does not read as a config reset.
        expect(announcement.message).toContain('wallet and chat trading settings remain unchanged');
        expect(announcement.options.reply_markup).toEqual({
            inline_keyboard: [
                [
                    { text: '📈 Portfolio', callback_data: 'startup:portfolio' },
                    { text: '💰 Balance', callback_data: 'startup:balance' },
                ],
                [{ text: '⚙️ Settings', callback_data: 'startup:settings' }],
            ],
        });
    });

    it('broadcasts the update to every active chat', async () => {
        const configService = { get: jest.fn((_key: string, fallback?: unknown) => fallback) };
        const telegramWorkspace = {
            getActiveChatIds: jest.fn().mockResolvedValue(['chat-1', 'chat-2']),
        };
        const service = new ReportingService(
            configService as never,
            {} as never,
            {} as never,
            telegramWorkspace as never,
        );
        const sendSpy = jest
            .spyOn(
                service as unknown as {
                    sendMessageToChat: (...args: unknown[]) => Promise<void>;
                },
                'sendMessageToChat',
            )
            .mockResolvedValue(undefined);

        await (
            service as unknown as {
                broadcastStartupUpdate: () => Promise<void>;
            }
        ).broadcastStartupUpdate();

        expect(telegramWorkspace.getActiveChatIds).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledTimes(2);
        expect(sendSpy.mock.calls.map((call) => call[0])).toEqual(['chat-1', 'chat-2']);
    });
});

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

describe('ReportingService.sendPriceMissAlert', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    function createService() {
        const configService = { get: jest.fn((_key: string, fallback?: unknown) => fallback) };
        const telegramWorkspace = { getActiveChatIds: jest.fn().mockResolvedValue([]) };

        return new ReportingService(
            configService as never,
            {} as never,
            {} as never,
            telegramWorkspace as never,
        );
    }

    it('describes a stale-priced OPEN position instead of reusing the failed-execution template (verifier MAJOR fix)', async () => {
        const service = createService();
        const sendMessageSpy = jest
            .spyOn(
                service as unknown as { sendMessage: (...args: unknown[]) => Promise<void> },
                'sendMessage',
            )
            .mockResolvedValue(undefined);

        await service.sendPriceMissAlert({
            tokenMint: 'MINT123',
            symbol: 'FOO',
            misses: 5,
            reason: 'price_miss_x5: no fresh market price for 5 consecutive ticks',
            details:
                'Trade has gone dark: stop-loss/trailing-stop cannot be evaluated without a live price.',
            targetChatId: 'chat-1',
        });

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        const [message, , , targetChatId] = sendMessageSpy.mock.calls[0] as [
            string,
            unknown,
            number,
            string,
        ];
        expect(targetChatId).toBe('chat-1');
        expect(message).toContain('MINT123');
        expect(message).toContain('OPEN');
        expect(message).toContain('5');

        // Nothing failed to execute and a position is in fact open -- the old
        // sendTradeFailureAlert reuse asserted the opposite of both.
        expect(message).not.toContain('EXECUTION FAILED');
        expect(message).not.toContain('No live trade was opened');
    });
});
