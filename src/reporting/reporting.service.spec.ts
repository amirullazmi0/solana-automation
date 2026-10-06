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

        expect(announcement.message).toContain('BUY AND SELL BANDS ARE LIVE');
        expect(announcement.message).toContain('Buy band');
        expect(announcement.message).toContain('Sell band');
        expect(announcement.message).toContain('Ranked by reward-to-risk');
        // Meta did not go away when zones shipped, and a broadcast that omits it reads as a removal.
        expect(announcement.message).toContain('Meta detection still runs');
        // Commands have to be discoverable from the broadcast: it is the only place most chats will
        // ever be told either surface exists.
        expect(announcement.message).toContain('/zones');
        expect(announcement.message).toContain('/meta');
        // The bands do not trade themselves, and a broadcast that leaves that implicit would have
        // chats believing the bot started entering on supply and demand levels.
        expect(announcement.message).toContain('view only');
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

describe('ReportingService.dashboardRow', () => {
    /** Reaches the private helper directly: it is the piece that can break every token alert. */
    function rowFor(configured: string | undefined, mint = 'So11111111111111111111111111111111111111112') {
        const service = Object.create(ReportingService.prototype) as ReportingService;
        Object.assign(service, {
            configService: {
                get: (_key: string, fallback?: unknown) => (configured === undefined ? fallback : configured),
            },
            logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        });
        return (service as unknown as { dashboardRow(m: string): unknown[] }).dashboardRow(mint);
    }

    it('builds a button pointing at the mint on the dashboard', () => {
        const row = rowFor('https://msoulmation.apps.arulize.com') as Array<Array<{ text: string; url: string }>>;
        expect(row).toHaveLength(1);
        expect(row[0][0].url).toBe(
            'https://msoulmation.apps.arulize.com/dashboard/?mint=So11111111111111111111111111111111111111112',
        );
    });

    it('does not double the slash when the base already ends in one', () => {
        const row = rowFor('https://example.com/') as Array<Array<{ url: string }>>;
        expect(row[0][0].url).toContain('https://example.com/dashboard/?mint=');
    });

    // Telegram validates every url it is handed and rejects the WHOLE message with a 400 when one
    // is malformed. A half-configured base would therefore not produce a dead button, it would
    // silently delete every token alert this bot sends -- the same failure mode as the unescaped
    // underscore in /status.
    // A bare hostname is what a person actually has in hand, and demanding the scheme would turn a
    // forgotten "https://" into a silently missing button.
    it('accepts a bare hostname and assumes https', () => {
        const row = rowFor('msoulmation.apps.arulize.com') as Array<Array<{ url: string }>>;
        expect(row[0][0].url).toBe(
            'https://msoulmation.apps.arulize.com/dashboard/?mint=So11111111111111111111111111111111111111112',
        );
    });

    it('keeps an explicit http scheme instead of upgrading it', () => {
        const row = rowFor('http://192.168.1.10:3100') as Array<Array<{ url: string }>>;
        expect(row[0][0].url).toContain('http://192.168.1.10:3100/dashboard/?mint=');
    });

    it('emits nothing rather than a broken url', () => {
        expect(rowFor(undefined)).toEqual([]);
        expect(rowFor('')).toEqual([]);
        expect(rowFor('   ')).toEqual([]);
        // A space cannot appear in a host and is the shape of a sentence typed into the field.
        expect(rowFor('not a url')).toEqual([]);
        // No dot and not localhost: a typo, and a typo here is an outage rather than a dead button.
        expect(rowFor('msoulmation')).toEqual([]);
    });

    // A javascript: or file: base parses fine and would ship a button Telegram either rejects or,
    // worse, renders.
    it('refuses a scheme that is not http or https', () => {
        expect(rowFor('javascript:alert(1)')).toEqual([]);
        expect(rowFor('file:///etc/passwd')).toEqual([]);
        expect(rowFor('ftp://example.com')).toEqual([]);
    });

    it('escapes the mint rather than pasting it into the query raw', () => {
        const row = rowFor('https://example.com', 'a b&c') as Array<Array<{ url: string }>>;
        expect(row[0][0].url).toContain('mint=a%20b%26c');
    });
});
