import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Cron } from '@nestjs/schedule';
import { Connection } from '@solana/web3.js';
import axios from 'axios';
import * as https from 'https';
import * as TelegramBot from 'node-telegram-bot-api';
import { DexLimiter } from '../common/dex-limiter';
import { computeNetProfitUsd } from '../common/fee-utils';
import { TokenMetadata } from '../dto/analyzer.dto';
import {
    TradeFailureAlertParams,
    WatchlistReasonMapping,
    WatchlistStatusUpdateParams,
    WatchlistTelegramSeverity,
    WatchlistTelegramStatus,
} from '../dto/reporting.dto';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramWorkspaceService } from '../telegram/telegram-workspace.service';
import { ScannerService } from '../scanner/scanner.service';
import { TradeService } from '../trade/trade.service';

@Injectable()
export class ReportingService implements OnModuleInit {
    private readonly logger = new Logger(ReportingService.name);
    private readonly bot: TelegramBot;
    private readonly connection: Connection;
    private readonly httpsAgent: https.Agent;
    private readonly pendingWithdrawAddress = new Map<string, string>();

    // Cache for resolved IPs
    private ipCache: Record<string, string> = {
        '1.1.1.1': '1.1.1.1',
        '8.8.8.8': '8.8.8.8',
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly moduleRef: ModuleRef,
        private readonly telegramWorkspace: TelegramWorkspaceService,
    ) {
        const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');

        const rpcEndpoint = this.configService.get<string>('RPC_ENDPOINT');
        if (rpcEndpoint) {
            this.connection = new Connection(rpcEndpoint, 'confirmed');
        }

        if (token && token !== 'your_telegram_bot_token') {
            this.bot = new TelegramBot(token, { polling: true });
            this.logger.log('Telegram bot initialized with polling enabled');
        } else {
            this.logger.warn(
                'Telegram bot token not provided. Alerts will be logged to console only.',
            );
        }

        // Inisialisasi DNS Hardening HTTPS Agent dengan keepAlive
        this.httpsAgent = new https.Agent({
            family: 4,
            keepAlive: true,
            lookup: async (hostname, options, cb) => {
                try {
                    const ip = await this.resolveDns(hostname);
                    if (ip) {
                        cb(null, ip, 4);
                    } else {
                        import('dns')
                            .then(({ lookup: dnsLookup }) => {
                                dnsLookup(hostname, options, cb);
                            })
                            .catch((err) => {
                                cb(err, '', 4);
                            });
                    }
                } catch (e) {
                    cb(e as Error, '', 4);
                }
            },
        });
    }

    onModuleInit() {
        if (this.bot) {
            this.setupBotListeners();
        }
    }

    private setupBotListeners() {
        this.bot.on('message', async (msg) => {
            const text = msg.text;
            const incomingChatId = msg.chat.id.toString();

            if (!text) return;

            const chatName = 'title' in msg.chat ? msg.chat.title : msg.chat.username;
            this.logger.log(
                `Telegram update from chat ${incomingChatId} (${msg.chat.type}${chatName ? `: ${chatName}` : ''})`,
            );

            const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
            const normalizedText = this.normalizeActionText(text);

            if (!this.telegramWorkspace.isChatAllowed(incomingChatId)) {
                await this.sendMessage(
                    '*Access denied.* Chat ini belum di-whitelist untuk mode development.',
                    {},
                    0,
                    incomingChatId,
                );
                return;
            }

            await this.telegramWorkspace.upsertTelegramChat({
                id: incomingChatId,
                type: msg.chat.type,
                title: 'title' in msg.chat ? msg.chat.title || null : null,
                username: msg.chat.username || null,
            });

            try {
                if (
                    await this.handlePendingWithdrawAddressInput(
                        incomingChatId,
                        text,
                        command,
                        normalizedText,
                    )
                ) {
                    return;
                }

                if (command === '/start' || command === '/help') {
                    await this.handleStartFlow(msg, incomingChatId);
                } else if (command === '/chatid' || command === '/id') {
                    await this.handleChatIdRequest(msg, incomingChatId);
                } else if (command === '/balance' || normalizedText === 'balance') {
                    await this.handleBalanceRequest(incomingChatId);
                } else if (
                    command === '/porto' ||
                    normalizedText === 'porto' ||
                    normalizedText === 'portfolio'
                ) {
                    await this.handlePortoRequest(incomingChatId);
                } else if (
                    command === '/setting' ||
                    normalizedText === 'setting' ||
                    normalizedText === 'settings'
                ) {
                    await this.handleSettingsRequest(incomingChatId);
                } else if (
                    command === '/winrate' ||
                    normalizedText === 'winrate' ||
                    normalizedText === 'win rate' ||
                    normalizedText === 'winrate'
                ) {
                    await this.handleWinRateRequest(incomingChatId);
                } else if (command === '/status' || normalizedText === 'status') {
                    await this.handleStatusRequest(incomingChatId);
                } else if (normalizedText === 'watchlist') {
                    await this.handleWatchlistRequest(incomingChatId);
                } else if (command === '/withdraw' || normalizedText === 'withdraw') {
                    await this.handleWithdrawStart(incomingChatId);
                } else if (this.isSolanaAddress(text)) {
                    await this.handleTokenInput(text, incomingChatId);
                }
            } catch (error) {
                const msgText = error instanceof Error ? error.message : String(error);
                this.logger.error(`Telegram command failed: ${msgText}`);
                await this.sendMessage(`*Error:* ${msgText}`, {}, 0, incomingChatId);
            }
        });

        this.bot.on('callback_query', async (query) => {
            await this.handleCallbackQuery(query);
        });
    }

    private isSolanaAddress(text: string): boolean {
        return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
    }

    private normalizeActionText(text: string): string {
        return text
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private async handleChatIdRequest(msg: TelegramBot.Message, targetChatId: string) {
        const chatName = 'title' in msg.chat ? msg.chat.title : msg.chat.username || 'private';
        await this.sendMessage(
            `Chat ID: \`${targetChatId}\`\nType: \`${msg.chat.type}\`\nName: \`${chatName}\``,
            {},
            0,
            targetChatId,
        );
    }

    private async handleStartFlow(msg: TelegramBot.Message, targetChatId: string) {
        const walletResult = await this.telegramWorkspace.ensureWalletForChat(targetChatId);
        const publicKey = walletResult.keypair.publicKey.toBase58();
        const chatLabel = 'title' in msg.chat ? msg.chat.title || 'Unnamed chat' : 'private chat';
        const walletMessage = walletResult.created
            ? `*Wallet connected in this chat.*\n\nAddress: \`${publicKey}\`\nTop up SOL to this address before trading.`
            : `*Wallet already connected in this chat.*\n\nAddress: \`${publicKey}\``;

        await this.sendMessage(walletMessage, {}, 0, targetChatId);
        await this.sendMainMenu(targetChatId, chatLabel);
    }

    private async sendMainMenu(targetChatId?: string, chatLabel?: string) {
        const message =
            `🚀 *Your Msoulmation Bot Active*\n` +
            `${chatLabel ? `\`${chatLabel}\`\n\n` : '\n'}` +
            `Pick a section below.`;

        const options: TelegramBot.SendMessageOptions = {
            reply_markup: {
                keyboard: [
                    [{ text: '\uD83D\uDCBC Balance' }, { text: '\uD83D\uDCC8 Portfolio' }],
                    [{ text: '\u2699\uFE0F Settings' }, { text: '\uD83D\uDCC8 Win Rate' }],
                    [{ text: '\uD83D\uDC40 Watchlist' }, { text: '\uD83D\uDCB8 Withdraw' }],
                ],
                resize_keyboard: true,
            },
        };

        await this.sendMessage(message, options, 0, targetChatId);
    }

    private async handleWatchlistRequest(targetChatId?: string) {
        const pendingWatchlist = await this.prismaService.watchlist.findMany({
            where: { status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
            take: 10,
        });

        if (pendingWatchlist.length === 0) {
            await this.sendMessage(
                '👀 *Watchlist empty.* No tokens are being tracked right now.',
                {},
                0,
                targetChatId,
            );
            return;
        }

        await this.sendMessage(
            `🔭 *WATCHLIST RADAR*\nShowing ${pendingWatchlist.length} tracked tokens.`,
            {},
            0,
            targetChatId,
        );

        for (const item of pendingWatchlist) {
            const symbol = item.symbol || 'UNKNOWN';
            const tokenName = item.tokenName || 'Unknown';
            const ageSource = item.pairCreatedAt || item.createdAt;
            const ageHours = Math.max(
                (Date.now() - new Date(ageSource).getTime()) / (1000 * 60 * 60),
                0,
            );
            const title = item.isPumpFun ? '🔥 *CTO CANDIDATE DETECTED*' : '🌊 *SECOND-WAVE RADAR*';
            const mcapDisplay =
                typeof item.mcap === 'number' ? `$${item.mcap.toLocaleString()}` : 'N/A';
            const liquidityDisplay =
                typeof item.liquidity === 'number' ? `$${item.liquidity.toLocaleString()}` : 'N/A';
            const surgeDisplay =
                typeof item.volumeSurge === 'number' ? `${item.volumeSurge.toFixed(2)}x` : 'N/A';
            const volDisplay = typeof item.volScore === 'number' ? item.volScore.toFixed(4) : 'N/A';
            const zDisplay = typeof item.zScore === 'number' ? item.zScore.toFixed(2) : 'N/A';
            const websiteDisplay = item.hasWebsite ? 'Yes' : 'No';
            const twitterDisplay = item.hasTwitter ? 'Yes' : 'No';
            const telegramDisplay = item.hasTelegram ? 'Yes' : 'No';
            const ctoDisplay =
                item.isCommunityTakeover === undefined || item.isCommunityTakeover === null
                    ? 'Unknown'
                    : item.isCommunityTakeover
                      ? 'Yes'
                      : 'No';
            const whaleScoreDisplay =
                typeof item.whaleSignalScore === 'number'
                    ? item.whaleSignalScore.toFixed(0)
                    : 'N/A';

            const msg =
                `${title}\n` +
                `Token: ${symbol}\n` +
                `Name: ${tokenName}\n` +
                `Mint: \`${item.tokenMint}\`\n\n` +
                `MCap: \`${mcapDisplay}\`\n` +
                `Liquidity: \`${liquidityDisplay}\`\n` +
                `Surge: \`${surgeDisplay}\`\n` +
                `VoL: \`${volDisplay}\` | Z: \`${zDisplay}\`\n` +
                `Age: \`${ageHours.toFixed(2)}h\`\n` +
                `Socials: \`W:${websiteDisplay} T:${twitterDisplay} G:${telegramDisplay}\`\n` +
                `Whale Score: \`${whaleScoreDisplay}/100\`\n` +
                `CTO: \`${ctoDisplay}\`\n\n` +
                `Status: \`MONITORING...\``;

            const buttons: TelegramBot.InlineKeyboardButton[][] = [
                [
                    { text: 'Pump.fun', url: `https://pump.fun/coin/${item.tokenMint}` },
                    {
                        text: 'DexScreener',
                        url: `https://dexscreener.com/solana/${item.tokenMint}`,
                    },
                ],
                [
                    { text: 'RugCheck', url: `https://rugcheck.xyz/tokens/${item.tokenMint}` },
                    { text: 'Solscan', url: `https://solscan.io/token/${item.tokenMint}` },
                ],
            ];

            await this.sendMessage(
                msg,
                {
                    reply_markup: { inline_keyboard: buttons },
                },
                0,
                targetChatId,
            );
        }
    }

    private async handleTokenInput(mint: string, targetChatId?: string) {
        const symbol = await this.fetchTokenSymbolFromDex(mint);
        const message =
            `🪙 *Token Detected: ${symbol}*\n` +
            `Mint: \`${mint}\`\n\n` +
            `What would you like to do with this token?`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '🟢 Buy', callback_data: `buy_menu:${mint}` },
                { text: '🔴 Sell', callback_data: `sell_menu:${mint}` },
            ],
            [
                { text: 'Pump.fun', url: `https://pump.fun/coin/${mint}` },
                { text: 'DexScreener', url: `https://dexscreener.com/solana/${mint}` },
            ],
            [{ text: 'RugCheck', url: `https://rugcheck.xyz/tokens/${mint}` }],
        ];

        await this.sendMessage(
            message,
            {
                reply_markup: { inline_keyboard: buttons },
            },
            0,
            targetChatId,
        );
    }

    private async handleCallbackQuery(query: TelegramBot.CallbackQuery) {
        const data = query.data;
        if (!data) return;

        const targetChatId = query.message?.chat.id.toString();
        if (!targetChatId) {
            await this.safeAnswerCallbackQuery(query.id);
            return;
        }

        await this.safeAnswerCallbackQuery(query.id);

        const [action, payload] = data.split(':');

        try {
            if (action === 'buy_menu') {
                await this.sendBuyMenu(payload, targetChatId);
            } else if (action === 'sell_menu') {
                await this.sendSellMenu(payload, targetChatId);
            } else if (action === 'buy_exec') {
                const [mint, amount] = payload.split('|');
                await this.executeManualBuy(mint, Number.parseFloat(amount), targetChatId);
            } else if (action === 'sell_exec') {
                const [mint, percent] = payload.split('|');
                await this.executeManualSell(mint, Number.parseFloat(percent), targetChatId);
            } else if (action === 'settings') {
                const [section, value] = payload.split('|');
                await this.handleSettingsCallback(section, value, targetChatId);
            } else if (action === 'withdraw') {
                const [mode, value] = payload.split('|');
                await this.handleWithdrawCallback(mode, value, targetChatId);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Callback query failed: ${msg}`);
        }
    }

    private async safeAnswerCallbackQuery(queryId: string) {
        try {
            await this.bot.answerCallbackQuery(queryId);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to answer callback query ${queryId}: ${msg}`);
        }
    }

    private async sendBuyMenu(mint: string, targetChatId?: string) {
        const message = `🟢 *Choose Buy Amount ($USD):*\nToken: \`${mint}\`\n\nQuick presets for this position.`;
        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '💵 $2', callback_data: `buy_exec:${mint}|5` },
                { text: '💵 $5', callback_data: `buy_exec:${mint}|5` },
                { text: '💵 $10', callback_data: `buy_exec:${mint}|10` },
            ],
            [
                { text: '💵 $15', callback_data: `buy_exec:${mint}|15` },
                { text: '💵 $20', callback_data: `buy_exec:${mint}|20` },
            ],
            [
                { text: 'Pump.fun', url: `https://pump.fun/coin/${mint}` },
                { text: 'DexScreener', url: `https://dexscreener.com/solana/${mint}` },
            ],
        ];

        await this.sendMessage(
            message,
            {
                reply_markup: { inline_keyboard: buttons },
            },
            0,
            targetChatId,
        );
    }
    private async sendSellMenu(mint: string, targetChatId?: string) {
        const message = `🔴 *Choose Sell Percentage:*\nToken: \`${mint}\`\n\nSelect the exit size.`;
        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '🚪 Sell all', callback_data: `sell_exec:${mint}|1.0` },
                { text: '75%', callback_data: `sell_exec:${mint}|0.75` },
            ],
            [
                { text: '50%', callback_data: `sell_exec:${mint}|0.5` },
                { text: '25%', callback_data: `sell_exec:${mint}|0.25` },
            ],
            [
                { text: 'Pump.fun', url: `https://pump.fun/coin/${mint}` },
                { text: 'DexScreener', url: `https://dexscreener.com/solana/${mint}` },
            ],
        ];

        await this.sendMessage(
            message,
            {
                reply_markup: { inline_keyboard: buttons },
            },
            0,
            targetChatId,
        );
    }
    private async handleBalanceRequest(targetChatId: string) {
        const tradeService = this.moduleRef.get(TradeService, { strict: false });
        const { publicKey, balanceSol, balanceUsd } =
            await tradeService.getWalletBalanceForChat(targetChatId);

        const message =
            `💼 *WALLET BALANCE*\n` +
            `Address: \`${publicKey}\`\n` +
            `SOL: \`${balanceSol.toFixed(4)}\`\n` +
            `USD: \`$${balanceUsd.toFixed(2)}\``;

        await this.sendMessage(message, {}, 0, targetChatId);
    }

    private async handlePortoRequest(targetChatId: string) {
        const tradeService = this.moduleRef.get(TradeService, { strict: false });
        const portfolio = await tradeService.getPortfolioForChat(targetChatId);

        if (portfolio.length === 0) {
            await this.sendMessage('📭 *Portfolio is empty.*', {}, 0, targetChatId);
            return;
        }

        await this.sendMessage(
            '📊 *PORTFOLIO*\nShowing ' + portfolio.length + ' tracked token(s).',
            {},
            0,
            targetChatId,
        );

        for (const holding of portfolio) {
            const valueUsd = holding.valueUsd ?? 0;
            const pnlUsd = holding.pnlUsd ?? 0;
            const pnlPercent = holding.pnlPercent ?? 0;
            const pnlEmoji = pnlUsd >= 0 ? '🟢' : '🔴';
            const message =
                '🪙 *' +
                (holding.symbol || 'UNKNOWN') +
                '*\n' +
                'Mint: `' +
                holding.mint +
                '`\n' +
                'Balance: `' +
                holding.balance.toFixed(4) +
                '`\n' +
                'Value: `$' +
                valueUsd.toFixed(2) +
                '`\n' +
                'P&L: ' +
                pnlEmoji +
                ' `$' +
                pnlUsd.toFixed(2) +
                '` (`' +
                pnlPercent.toFixed(2) +
                '%`)' +
                '\n' +
                'Source: `' +
                holding.source +
                '`';

            const buttons: TelegramBot.InlineKeyboardButton[][] = [
                [
                    { text: 'Buy', callback_data: 'buy_menu:' + holding.mint },
                    { text: 'Sell', callback_data: 'sell_menu:' + holding.mint },
                ],
                [
                    { text: 'Pump.fun', url: 'https://pump.fun/coin/' + holding.mint },
                    { text: 'DexScreener', url: 'https://dexscreener.com/solana/' + holding.mint },
                ],
            ];

            await this.sendMessage(
                message,
                {
                    reply_markup: { inline_keyboard: buttons },
                },
                0,
                targetChatId,
            );
        }
    }

    private async handleWinRateRequest(targetChatId: string) {
        const tradeService = this.moduleRef.get(TradeService, { strict: false });
        const stats = await tradeService.getWinRateForChat(targetChatId);

        await this.sendMessage(
            `📈 *WINRATE*\n` +
                `Trades: \`${stats.total}\`\n` +
                `Wins: \`${stats.wins}\`\n` +
                `Losses: \`${stats.losses}\`\n` +
                `Win rate: \`${stats.winRate.toFixed(2)}%\``,
            {},
            0,
            targetChatId,
        );
    }

    private async handleSettingsRequest(targetChatId: string) {
        const settings = await this.telegramWorkspace.getChatSettings(targetChatId);
        const message =
            `⚙️ SETTINGS\n` +
            `Tune risk and entry size for this chat.\n\n` +
            `Current values\n` +
            `- Total slots: \`${settings.totalSlots}\` 🧩\n` +
            `  Max open positions allowed at the same time.\n` +
            `- Position size: \`$${settings.positionSizeUsd.toFixed(2)}\` 💵\n` +
            `  Default USD amount used per auto-buy entry.\n` +
            `- Slippage on SOL: \`${(settings.slippageOnSol * 100).toFixed(2)}%\` 🌐\n` +
            `  Price tolerance used when swapping.\n` +
            `- Dry run: \`${settings.dryRun ? 'true' : 'false'}\` 🧪\n` +
            `  When true, automatic swaps are skipped.\n\n` +
            `Choose a preset below.`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '1 slot', callback_data: 'settings:slots|1' },
                { text: '2 slots', callback_data: 'settings:slots|2' },
                { text: '3 slots', callback_data: 'settings:slots|3' },
                { text: '4 slots', callback_data: 'settings:slots|4' },
            ],
            [
                { text: '$2 / entry', callback_data: 'settings:position|2' },
                { text: '$4 / entry', callback_data: 'settings:position|4' },
                { text: '$5 / entry', callback_data: 'settings:position|5' },
                { text: '$10 / entry', callback_data: 'settings:position|10' },
            ],
            [
                { text: '$15 / entry', callback_data: 'settings:position|15' },
                { text: '$20 / entry', callback_data: 'settings:position|20' },
                { text: '$50 / entry', callback_data: 'settings:position|50' },
                { text: '$100 / entry', callback_data: 'settings:position|100' },
            ],
            [
                { text: '0.50% slippage', callback_data: 'settings:slippage|0.005' },
                { text: '1.00% slippage', callback_data: 'settings:slippage|0.01' },
                { text: '2.00% slippage', callback_data: 'settings:slippage|0.02' },
                { text: '3.00% slippage', callback_data: 'settings:slippage|0.03' },
            ],
            [
                { text: 'dryRun true', callback_data: 'settings:dryrun|true' },
                { text: 'dryRun false', callback_data: 'settings:dryrun|false' },
            ],
        ];

        await this.sendMessage(
            message,
            {
                reply_markup: { inline_keyboard: buttons },
            },
            0,
            targetChatId,
        );
    }
    private async handleSettingsCallback(section: string, value: string, targetChatId: string) {
        const updates: {
            totalSlots?: number;
            positionSizeUsd?: number;
            slippageOnSol?: number;
            dryRun?: boolean;
        } = {};

        if (section === 'slots') {
            updates.totalSlots = Number.parseInt(value, 10);
        } else if (section === 'position') {
            updates.positionSizeUsd = Number.parseFloat(value);
        } else if (section === 'slippage') {
            updates.slippageOnSol = Number.parseFloat(value);
        } else if (section === 'dryrun') {
            updates.dryRun = value === 'true';
        }

        if (Object.keys(updates).length === 0) {
            return;
        }

        await this.telegramWorkspace.updateChatSettings(targetChatId, updates);
        await this.handleSettingsRequest(targetChatId);
    }

    private async handleWithdrawStart(targetChatId: string) {
        this.pendingWithdrawAddress.set(targetChatId, '');
        await this.sendMessage(
            '💸 *Send Solana to Address*\n\nSend the destination Solana address in the next message.',
            {},
            0,
            targetChatId,
        );
    }

    private async handlePendingWithdrawAddressInput(
        targetChatId: string,
        text: string,
        command?: string,
        normalizedText?: string,
    ): Promise<boolean> {
        if (!this.pendingWithdrawAddress.has(targetChatId)) {
            return false;
        }

        const textCommand = (command || text.split(/\s+/)[0].split('@')[0].toLowerCase()).trim();
        const actionText = (normalizedText || this.normalizeActionText(text)).trim();

        const isNavigationText =
            textCommand.startsWith('/') ||
            [
                'balance',
                'porto',
                'portfolio',
                'setting',
                'settings',
                'winrate',
                'win rate',
                'status',
                'watchlist',
                'withdraw',
            ].includes(actionText);

        if (isNavigationText) {
            this.pendingWithdrawAddress.delete(targetChatId);
            return false;
        }

        const trimmed = text.trim();
        if (!this.isSolanaAddress(trimmed)) {
            await this.sendMessage('⚠️ Please send a valid Solana address.', {}, 0, targetChatId);
            return true;
        }

        this.pendingWithdrawAddress.set(targetChatId, trimmed);
        await this.sendWithdrawMenu(trimmed, targetChatId);
        return true;
    }

    private async sendWithdrawMenu(destinationAddress: string, targetChatId: string) {
        const tradeService = this.moduleRef.get(TradeService, { strict: false });
        const balance = await tradeService.getWalletBalanceForChat(targetChatId);
        const spendableUsd = Math.max(balance.balanceUsd - 0.75, 0);
        const presetUsd = (pct: number) => Math.max(spendableUsd * pct, 0);

        const message =
            `💸 *Send Solana to Address*\n` +
            `Destination: \`${destinationAddress}\`\n\n` +
            `Choose an amount preset below.`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                {
                    text: `$${presetUsd(0.2).toFixed(2)}`,
                    callback_data: `withdraw:usd|${presetUsd(0.2).toFixed(2)}`,
                },
                {
                    text: `$${presetUsd(0.5).toFixed(2)}`,
                    callback_data: `withdraw:usd|${presetUsd(0.5).toFixed(2)}`,
                },
                {
                    text: `$${presetUsd(0.8).toFixed(2)}`,
                    callback_data: `withdraw:usd|${presetUsd(0.8).toFixed(2)}`,
                },
                {
                    text: `$${presetUsd(1.0).toFixed(2)}`,
                    callback_data: `withdraw:usd|${presetUsd(1.0).toFixed(2)}`,
                },
            ],
            [
                { text: '$10', callback_data: 'withdraw:usd|10' },
                { text: '$20', callback_data: 'withdraw:usd|20' },
                { text: '$50', callback_data: 'withdraw:usd|50' },
                { text: '$100', callback_data: 'withdraw:usd|100' },
            ],
            [{ text: '❌ Cancel', callback_data: 'withdraw:cancel|1' }],
        ];

        await this.sendMessage(
            message,
            { reply_markup: { inline_keyboard: buttons } },
            0,
            targetChatId,
        );
    }

    private async handleWithdrawCallback(mode: string, value: string, targetChatId: string) {
        if (mode === 'cancel') {
            this.pendingWithdrawAddress.delete(targetChatId);
            await this.sendMessage('❌ Withdraw flow cancelled.', {}, 0, targetChatId);
            return;
        }

        const destinationAddress = this.pendingWithdrawAddress.get(targetChatId);
        if (!destinationAddress) {
            await this.sendMessage(
                '⚠️ No destination address found. Start withdraw flow again.',
                {},
                0,
                targetChatId,
            );
            return;
        }

        const tradeService = this.moduleRef.get(TradeService, { strict: false });
        const amountMode = mode === 'percent' ? 'percent' : 'usd';
        const amountValue = Number.parseFloat(value);
        const result = await tradeService.sendSolanaToAddress(
            targetChatId,
            destinationAddress,
            amountMode,
            amountValue,
        );

        if (result.success) {
            this.pendingWithdrawAddress.delete(targetChatId);
            await this.sendMessage(`✅ *Success:* ${result.message}`, {}, 0, targetChatId);
        } else {
            await this.sendMessage(`❌ *Failed:* ${result.message}`, {}, 0, targetChatId);
        }
    }

    private async executeManualBuy(mint: string, amount: number, targetChatId?: string) {
        await this.sendMessage(`*Processing Buy $${amount}...*`, {}, 0, targetChatId);
        try {
            const tradeService = this.moduleRef.get(TradeService, { strict: false });
            const result = await tradeService.handleManualBuy(mint, amount, targetChatId);
            if (result.success) {
                await this.sendMessage(`*Success:* ${result.message}`, {}, 0, targetChatId);
            } else {
                await this.sendMessage(`*Failed:* ${result.message}`, {}, 0, targetChatId);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await this.sendMessage(`*Error:* ${msg}`, {}, 0, targetChatId);
        }
    }

    private async executeManualSell(mint: string, percent: number, targetChatId?: string) {
        await this.sendMessage(
            `*Processing Sell ${(percent * 100).toFixed(0)}%...*`,
            {},
            0,
            targetChatId,
        );
        try {
            const tradeService = this.moduleRef.get(TradeService, { strict: false });
            const result = await tradeService.handleManualSell(mint, percent, targetChatId);
            if (result.success) {
                await this.sendMessage(`*Success:* ${result.message}`, {}, 0, targetChatId);
            } else {
                await this.sendMessage(`*Failed:* ${result.message}`, {}, 0, targetChatId);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await this.sendMessage(`*Error:* ${msg}`, {}, 0, targetChatId);
        }
    }

    private async fetchTokenSymbolFromDex(tokenMint: string): Promise<string> {
        try {
            const response = await DexLimiter.get<{
                pairs: Array<{ baseToken?: { symbol?: string } }>;
            }>(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
                timeout: 5000,
                httpsAgent: this.httpsAgent,
            });
            return response.data?.pairs?.[0]?.baseToken?.symbol || 'UNKNOWN';
        } catch {
            return 'UNKNOWN';
        }
    }

    async handleStatusRequest(targetChatId?: string) {
        const openTrades = await this.prismaService.trade.findMany({
            where: { status: 'OPEN', mode: 'LIVE' },
        });

        if (openTrades.length === 0) {
            await this.sendMessage('*No open positions currently.*', {}, 0, targetChatId);
            return;
        }

        const scannerService = this.moduleRef.get(ScannerService, { strict: false });
        const stats = scannerService.getScannerStatus();

        let statusMsg = `🤖 *BOT SYSTEM STATUS*\n`;
        statusMsg += `📡 *Scanner:* \`${stats.active}/${stats.max}\` monitor | \`${stats.seen}\` seen\n`;
        statusMsg += `━━━━━━━━━━━━━━━━━━\n\n`;

        statusMsg += '📊 *Active Portfolio:*\n\n';

        for (const trade of openTrades) {
            const currentPrice = await this.fetchCurrentPrice(trade.tokenMint);
            const profit = currentPrice
                ? ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100
                : 0;

            const priceDisplay = currentPrice ? `$${currentPrice.toFixed(8)}` : '(N/A)';
            const profitDisplay = currentPrice
                ? `${profit >= 0 ? '+' : ''}${profit.toFixed(2)}%`
                : '(N/A)';
            const emoji = profit >= 0 ? '📈' : '📉';
            const displaySymbol =
                trade.symbol && trade.symbol !== 'UNKNOWN' ? trade.symbol : 'UNKNOWN';
            const modeBadge = trade.targetTakeProfit ? ' 🔥 `[REBOUND & CTO]`' : '';

            statusMsg += `Slot ${trade.slotNumber}: *${displaySymbol}*${modeBadge}\n`;
            statusMsg += `Mint: \`${trade.tokenMint}\`\n`;
            statusMsg += `Entry: \`$${trade.entryPrice.toFixed(8)}\` | Current: \`${priceDisplay}\` ${emoji}\n`;
            statusMsg += `Profit/Loss: *${profitDisplay}*\n`;
            statusMsg += `Stop: \`$${trade.trailingStopPrice.toFixed(8)}\`\n\n`;
        }

        // 🕒 RECENT HISTORY: Tampilkan 5 transaksi terakhir yang laku
        const recentTrades = await this.prismaService.trade.findMany({
            where: { status: 'CLOSED', mode: 'LIVE' },
            orderBy: { updatedAt: 'desc' },
            take: 5,
        });

        if (recentTrades.length > 0) {
            statusMsg += `━━━━━━━━━━━━━━━━━━\n`;
            statusMsg += `🕒 *Recent History (Last 5):*\n\n`;
            for (const trade of recentTrades) {
                const profit = trade.profitUsd || 0;
                const emoji = profit >= 0 ? '💰' : '🛑';
                statusMsg += `${emoji} *${trade.symbol}*: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}\n`;
            }
        }

        await this.sendMessage(statusMsg, {}, 0, targetChatId);
    }

    async fetchCurrentPrice(tokenMint: string): Promise<number | null> {
        try {
            const apiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
            const response = await axios
                .get(`https://api.jup.ag/price/v3?ids=${tokenMint}`, {
                    timeout: 5000,
                    headers: { 'x-api-key': apiKey },
                    httpsAgent: this.httpsAgent,
                })
                .catch(() => null);

            if (response?.data) {
                const data = response.data as Record<
                    string,
                    { usdPrice?: number } | undefined
                > | null;
                const price = data?.[tokenMint]?.usdPrice;
                if (price && !isNaN(price)) {
                    return price;
                }
            }

            const dexResponse = await DexLimiter.get<{ pairs: Array<{ priceUsd?: string }> }>(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                {
                    timeout: 5000,
                    httpsAgent: this.httpsAgent,
                },
            ).catch(() => null);

            if (dexResponse?.data?.pairs?.[0]?.priceUsd) {
                return parseFloat(dexResponse.data.pairs[0].priceUsd);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Error fetching price for report: ${msg}`);
        }
        return null;
    }

    async sendBuyAlert(
        tokenMint: string,
        price: number,
        slotUsed: number,
        symbol?: string,
        socials?: TokenMetadata['socials'],
        strategy?: string,
        details?: {
            solSpent: number;
            tokensReceived?: number;
            solPrice?: number;
        },
        isDryRun = true,
        targetChatId?: string,
    ) {
        const displaySymbol = symbol || 'UNKNOWN';
        const prefix = isDryRun ? '🤖 [SIMULASI] ' : '🚀 ';
        const strategyDisplay = strategy ? `\n⚡ *Strategy:* \`${strategy}\`` : '';

        let solDetails = '';
        if (details) {
            const totalUsdSpent = details.solSpent * (details.solPrice || 0);
            solDetails =
                `💸 *SOL Spent:* \`${details.solSpent.toFixed(4)} SOL\` *($${totalUsdSpent.toFixed(2)})*\n` +
                `💵 *SOL Price:* \`$${details.solPrice?.toFixed(2) || '0.00'}\`\n`;
        }

        const message =
            `${prefix}*SOLANA BUY ALERT* 🚀\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💎 *Token:* ${displaySymbol}\n` +
            `🆔 *Mint:* \`${tokenMint}\`\n` +
            `💰 *Price:* \`$${price.toFixed(8)}\`\n` +
            solDetails +
            `🧱 *Slot:* #${slotUsed}\n` +
            `━━━━━━━ 📊 ━━━━━━━\n` +
            `📈 *Action:* BUY EXECUTION${strategyDisplay}`;

        const row1: TelegramBot.InlineKeyboardButton[] = [];
        if (socials?.twitter) row1.push({ text: '🐦 Twitter', url: socials.twitter });
        if (socials?.telegram) row1.push({ text: '📱 Telegram', url: socials.telegram });

        const row2: TelegramBot.InlineKeyboardButton[] = [
            { text: '💊 Pump.fun', url: `https://pump.fun/coin/${tokenMint}` },
            { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${tokenMint}` },
            { text: '🛡️ RugCheck', url: `https://rugcheck.xyz/tokens/${tokenMint}` },
        ];

        const row3: TelegramBot.InlineKeyboardButton[] = [
            { text: '🔍 Solscan', url: `https://solscan.io/token/${tokenMint}` },
        ];

        const options: TelegramBot.SendMessageOptions = {
            reply_markup: {
                inline_keyboard: [row1, row2, row3].filter((r) => r.length > 0),
            },
        };

        await this.sendMessage(message, options, 0, targetChatId);
    }

    async sendTrailingAlert(
        tokenMint: string,
        newStopPrice: number,
        currentPrice: number,
        symbol?: string,
    ) {
        const displaySymbol = symbol || 'UNKNOWN';
        const message =
            `📈 *TRAILING STOP UPDATED*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💎 *Token:* ${displaySymbol}\n` +
            `🛑 *New Stop:* \`$${newStopPrice.toFixed(8)}\`\n` +
            `💹 *Price:* \`$${currentPrice.toFixed(8)}\``;
        await this.sendMessage(message);
    }

    async sendRiskAdjustmentAlert(params: {
        tokenMint: string;
        symbol?: string;
        currentPrice: number;
        newTrailingStop: number;
        baseTrailingDistancePercent: number;
        effectiveTrailingDistancePercent: number;
        volScore: number;
        priceChange1h: number;
        targetChatId?: string;
    }): Promise<void> {
        const displaySymbol = params.symbol || 'UNKNOWN';
        const trailingStopLine =
            params.newTrailingStop > 0
                ? `Trailing Stop: $${params.newTrailingStop.toFixed(8)}\n`
                : `Trailing Stop: pending activation\n`;
        const message =
            `🧠 *AI RISK ADJUSTMENT*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💎 *Token:* ${displaySymbol}\n` +
            `🆔 *Mint:* \`${params.tokenMint}\`\n` +
            `📉 *Price:* \`$${params.currentPrice.toFixed(8)}\`\n` +
            trailingStopLine +
            `📏 *Base Trail:* \`${params.baseTrailingDistancePercent.toFixed(1)}%\`\n` +
            `📏 *AI Trail:* \`${params.effectiveTrailingDistancePercent.toFixed(1)}%\`\n` +
            `🌪️ *VoL:* \`${params.volScore.toFixed(4)}\` | 1h: \`${params.priceChange1h.toFixed(2)}%\`\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Status: \`AI tightened exit risk due to high volatility.\``;

        await this.sendMessage(message, {}, 0, params.targetChatId);
    }

    async sendSellAlert(
        tokenMint: string,
        sellPrice: number,
        netProfitPercent: number,
        exitReason: string,
        symbol?: string,
        details?: {
            entryPriceUsd: number;
            exitPriceUsd: number;
            entryPriceSol?: number;
            exitPriceSol?: number;
            solSpent?: number;
            solReceived?: number;
            solProfitPercent?: number;
            usdSpent?: number;
            usdReceived?: number;
        },
        isDryRun = true,
        targetChatId?: string,
    ) {
        const displaySymbol = symbol || 'UNKNOWN';
        const isSuccess = netProfitPercent >= 0;
        const emoji = isSuccess ? '💰' : '🛑';
        const profitEmoji = isSuccess ? '🟢' : '🔴';
        const prefix = isDryRun ? '🤖 [SIMULASI] ' : '';

        let detailedStats = '';
        if (details) {
            const solProfitDisplay =
                details.solProfitPercent !== undefined
                    ? `${details.solProfitPercent >= 0 ? '🟢' : '🔴'} *SOL Profit:* \`${details.solProfitPercent.toFixed(2)}%\`\n`
                    : '';

            const usdSpentDisplay =
                details.usdSpent !== undefined && details.usdReceived !== undefined
                    ? `📥 *USD Spent:* \`$${details.usdSpent.toFixed(2)}\`\n` +
                      `📤 *USD Received:* \`$${details.usdReceived.toFixed(2)}\`\n`
                    : '';

            detailedStats =
                `💵 *USD Entry Price:* \`$${details.entryPriceUsd.toFixed(8)}\`\n` +
                `💵 *USD Sell Price:* \`$${details.exitPriceUsd.toFixed(8)}\`\n` +
                `💎 *SOL Entry Price:* \`${details.entryPriceSol?.toFixed(10) || '0.0000000000'} SOL\`\n` +
                `💎 *SOL Sell Price:* \`${details.exitPriceSol?.toFixed(10) || '0.0000000000'} SOL\`\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `📥 *SOL Spent:* \`${details.solSpent?.toFixed(4) || '0.0000'} SOL\`\n` +
                `📤 *SOL Received:* \`${details.solReceived?.toFixed(4) || '0.0000'} SOL\`\n` +
                usdSpentDisplay +
                solProfitDisplay;
        }

        const message =
            `${prefix}${emoji} *SOLANA SELL ALERT* ${emoji}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💎 *Token:* ${displaySymbol}\n` +
            `🆔 *Mint:* \`${tokenMint}\`\n` +
            `💰 *Sell Price:* \`$${sellPrice.toFixed(8)}\`\n` +
            `📊 *Result (USD):* ${profitEmoji} *${netProfitPercent.toFixed(2)}%*\n` +
            detailedStats +
            `━━━━━━━━━━━━━━━━━━\n` +
            `⚡ *Action:* ${exitReason.replace(/_/g, ' ')} TRIGGERED`;

        const buttons: TelegramBot.InlineKeyboardButton[] = [
            { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${tokenMint}` },
            { text: '🔍 Solscan', url: `https://solscan.io/token/${tokenMint}` },
        ];

        await this.sendMessage(
            message,
            {
                reply_markup: { inline_keyboard: [buttons] },
            },
            0,
            targetChatId,
        );
    }

    async sendBuySignalAlert(
        tokenMint: string,
        metadata?: TokenMetadata,
        options?: {
            strategy?: string;
            targetTakeProfit?: number;
            targetTrailingDistance?: number;
            targetStopLoss?: number;
        },
        isDryRun = true,
        targetChatId?: string,
    ) {
        const displaySymbol = metadata?.symbol || 'UNKNOWN';
        const strategy =
            options?.strategy || (metadata?.isCTO ? 'CTO Candidate' : 'Standard Second-Wave');
        const exitPlan = options
            ? `\nTarget: TP ${options.targetTakeProfit}% | TSL ${options.targetTrailingDistance}% | SL ${options.targetStopLoss}%`
            : '';
        const header = isDryRun
            ? '*MUST BUY SIGNAL - DRY RUN*'
            : '*MUST BUY SIGNAL - EXECUTION ATTEMPTING*';
        const modeLine = isDryRun
            ? 'Mode: `Signal only. Bot did not execute swap.`'
            : 'Mode: `Execution checks and swap attempt are running for this chat.`';

        const message =
            `${header}\n` +
            `Token: ${displaySymbol}\n` +
            `Mint: \`${tokenMint}\`\n` +
            `Strategy: \`${strategy}\`${exitPlan}\n\n` +
            `MCap: \`$${(metadata?.mcap || metadata?.marketCap || 0).toLocaleString()}\`\n` +
            `Liquidity: \`$${(metadata?.liquidity || 0).toLocaleString()}\`\n` +
            `Surge: \`${metadata?.volumeSurge?.toFixed(2) || 'N/A'}x\`\n` +
            `VoL: \`${metadata?.volScore?.toFixed(4) || 'N/A'}\` | Z: \`${metadata?.zScore?.toFixed(2) || 'N/A'}\`\n\n` +
            `${modeLine}`;

        const socialButtons: TelegramBot.InlineKeyboardButton[] = [];
        if (metadata?.socials?.twitter) {
            socialButtons.push({ text: 'Twitter', url: metadata.socials.twitter });
        }
        if (metadata?.socials?.telegram) {
            socialButtons.push({ text: 'Telegram', url: metadata.socials.telegram });
        }

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            socialButtons,
            [
                { text: 'Pump.fun', url: `https://pump.fun/coin/${tokenMint}` },
                { text: 'DexScreener', url: `https://dexscreener.com/solana/${tokenMint}` },
            ],
            [
                { text: 'RugCheck', url: `https://rugcheck.xyz/tokens/${tokenMint}` },
                { text: 'Solscan', url: `https://solscan.io/token/${tokenMint}` },
            ],
        ].filter((row) => row.length > 0);

        await this.sendMessage(
            message,
            { reply_markup: { inline_keyboard: buttons } },
            0,
            targetChatId,
        );
    }

    async sendSwapResultReport(params: {
        side: 'BUY' | 'SELL';
        tokenMint: string;
        symbol?: string;
        success: boolean;
        amountUsd?: number;
        amountSol?: number;
        txHash?: string;
        error?: string;
        dryRun?: boolean;
        targetChatId?: string;
        details?: string;
    }) {
        const {
            side,
            tokenMint,
            symbol,
            success,
            amountUsd,
            amountSol,
            txHash,
            error,
            dryRun = false,
            targetChatId,
            details,
        } = params;

        const displaySymbol = symbol || 'UNKNOWN';
        const actionLabel = side === 'BUY' ? 'BUY' : 'SELL';
        const header = success
            ? `✅ *SWAP ${actionLabel} SUCCESS*`
            : `❌ *SWAP ${actionLabel} FAILED*`;
        const modePrefix = dryRun ? '🤖 [SIMULASI] ' : '🚀 ';

        const usdLine =
            amountUsd !== undefined ? `💵 *USD Value:* \`$${amountUsd.toFixed(2)}\`\n` : '';
        const solLine =
            amountSol !== undefined ? `💎 *SOL Value:* \`${amountSol.toFixed(4)} SOL\`\n` : '';
        const txLine = txHash ? `🔗 *Tx:* \`${txHash}\`\n` : '';
        const errorLine = !success && error ? `⚠️ *Error:* \`${error}\`\n` : '';
        const detailsLine = details ? `${details}\n` : '';

        const message =
            `${modePrefix}${header}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💎 *Token:* ${displaySymbol}\n` +
            `🆔 *Mint:* \`${tokenMint}\`\n` +
            `📌 *Side:* \`${actionLabel}\`\n` +
            usdLine +
            solLine +
            txLine +
            errorLine +
            detailsLine +
            `━━━━━━━━━━━━━━━━━━\n` +
            (success
                ? 'Status: `Swap executed successfully.`'
                : 'Status: `Swap failed. No live trade was opened.`');

        await this.sendMessage(message, {}, 0, targetChatId);
    }

    async sendTradeFailureAlert(params: TradeFailureAlertParams): Promise<void> {
        const displaySymbol = params.symbol || 'UNKNOWN';
        const stageLabel = params.stage || 'PRE_SWAP';
        const routeLine = params.route ? `\u{1F9ED} Route: ${params.route}\n` : '';
        const amountUsdLine =
            params.amountUsd !== undefined
                ? `\u{1F4B5} Attempted USD: $${params.amountUsd.toFixed(2)}\n`
                : '';
        const amountSolLine =
            params.amountSol !== undefined
                ? `\u{1F48E} Attempted SOL: ${params.amountSol.toFixed(4)} SOL\n`
                : '';
        const detailsLine = params.details ? `\n\u{1F4CB} Details:\n${params.details}\n` : '';

        const message =
            `\u{26A0}\u{FE0F} ${params.side} EXECUTION FAILED\n` +
            `------------------\n` +
            `\u{1F48E} Token: ${displaySymbol}\n` +
            `\u{1F194} Mint: ${params.tokenMint}\n` +
            routeLine +
            `\u{1F9F1} Stage: ${stageLabel}\n` +
            `\u{1F6AB} Reason: ${params.reason}\n` +
            amountUsdLine +
            amountSolLine +
            detailsLine +
            `------------------\n` +
            `\u{1F6A6} Status: No live trade was opened.`;

        await this.sendMessage(message, { parse_mode: undefined }, 0, params.targetChatId);
    }

    async sendDepositNotification(params: {
        targetChatId: string;
        walletAddress: string;
        amountSol: number;
        newBalanceSol: number;
        signature: string;
    }): Promise<void> {
        const message =
            `✅ *DEPOSIT TERDETEKSI!*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🏦 *Wallet:* \`${params.walletAddress}\`\n` +
            `💎 *Masuk:* \`${params.amountSol.toFixed(4)} SOL\`\n` +
            `💼 *Saldo Baru:* \`${params.newBalanceSol.toFixed(4)} SOL\`\n` +
            `🔗 *Tx:* \`${params.signature}\`\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Status: \`Deposit berhasil ditambahkan ke saldo bot.\``;

        await this.sendMessage(message, {}, 0, params.targetChatId);
    }

    private mapAnalyzerReasonToTelegramStatus(
        reason = 'unknown',
        permanent = false,
        retryCount = 0,
        maxRetries = 0,
    ): WatchlistReasonMapping {
        const normalizedReason = reason || 'unknown';
        const zeroLiquidityStillRetrying =
            normalizedReason === 'zero_liquidity' &&
            !permanent &&
            maxRetries > 0 &&
            retryCount < maxRetries;

        if (zeroLiquidityStillRetrying) {
            return {
                status: 'WAITING',
                label: 'WAITING: zero_liquidity',
                severity: 'soft_fail',
                message:
                    'No valid liquidity found yet. New token liquidity can lag for a short window.',
                action: 'No buy. Continue monitoring until retry window is exhausted.',
            };
        }

        switch (normalizedReason) {
            case 'low_surge':
                return {
                    status: 'WAITING',
                    label: 'WAITING: low_surge',
                    severity: 'soft_fail',
                    message: 'Volume acceleration is not strong enough yet.',
                    action: 'No buy. Continue monitoring for stronger momentum.',
                };
            case 'low_metrics':
                return {
                    status: 'REJECTED',
                    label: 'REJECTED: low_metrics',
                    severity: 'soft_fail',
                    message: 'Momentum or quality metrics are still below threshold.',
                    action: 'No buy. Skip for now and wait for a fresh radar cycle.',
                };
            case 'low_vol_score':
                return {
                    status: 'WAITING',
                    label: 'WAITING: low_vol_score',
                    severity: 'soft_fail',
                    message: 'Volume-over-liquidity shock is not strong enough.',
                    action: 'No buy. Wait for stronger supply shock.',
                };
            case 'no_volume_anomaly':
                return {
                    status: 'WAITING',
                    label: 'WAITING: no_volume_anomaly',
                    severity: 'soft_fail',
                    message: 'Current volume is still normal, not a breakout anomaly.',
                    action: 'No buy. Continue monitoring.',
                };
            case 'whale_signal_too_weak':
                return {
                    status: 'WAITING',
                    label: 'WAITING: whale_signal_too_weak',
                    severity: 'soft_fail',
                    message: 'Older-token social/narrative score is not strong enough yet.',
                    action: 'No buy. Wait for stronger whale signal.',
                };
            case 'ai_rejected':
                return {
                    status: 'REJECTED',
                    label: 'REJECTED: ai_rejected',
                    severity: 'soft_fail',
                    message: 'AI conviction judge rejected the candidate.',
                    action: 'No buy. Token stays rejected until a fresh radar cycle.',
                };
            case 'noisy_pump':
                return {
                    status: 'REJECTED',
                    label: 'REJECTED: noisy_pump',
                    severity: 'soft_fail',
                    message: 'Micin noise filter detected fake-pump characteristics.',
                    action: 'No buy. Avoid chasing noisy momentum.',
                };
            case 'zero_liquidity':
                return {
                    status: 'REJECTED',
                    label: 'REJECTED: zero_liquidity',
                    severity: permanent ? 'hard_fail' : 'soft_fail',
                    message: 'No valid liquidity found.',
                    action: permanent
                        ? 'Permanent filter fail. Giving up.'
                        : 'No buy. Background radar may retry later.',
                };
            case 'high_concentration':
            case 'high_risk_score':
            case 'safety_rpc_failed':
            case 'creator_high_risk':
            case 'rugcheck_failed':
                return {
                    status: 'BLOCKED',
                    label: `BLOCKED: ${normalizedReason}`,
                    severity: 'hard_fail',
                    message: 'Rug/security risk is too high.',
                    action: 'Permanent filter fail. Giving up.',
                };
            default:
                return {
                    status: permanent ? 'BLOCKED' : 'REJECTED',
                    label: `${permanent ? 'BLOCKED' : 'REJECTED'}: ${normalizedReason}`,
                    severity: permanent ? 'hard_fail' : 'unknown',
                    message: 'Analyzer rejected token.',
                    action: permanent
                        ? 'Permanent filter fail. Giving up.'
                        : 'No buy. Continue only if radar sees a better setup.',
                };
        }
    }

    async sendWatchlistStatusUpdate(params: WatchlistStatusUpdateParams): Promise<void> {
        const mapping = this.mapAnalyzerReasonToTelegramStatus(
            params.reason,
            params.permanent,
            params.retryCount,
            params.maxRetries,
        );
        const displaySymbol = params.symbol || 'UNKNOWN';
        const routeLine = params.route ? `Route: \`${params.route}\`\n` : '';
        const retryLine =
            params.retryCount !== undefined && params.maxRetries !== undefined
                ? `Retry: \`${params.retryCount}/${params.maxRetries}\`\n`
                : '';
        const metricsLines = [
            params.volumeSurge !== undefined
                ? `volumeSurge: \`${params.volumeSurge.toFixed(2)}x\``
                : undefined,
            params.volScore !== undefined
                ? `volScore: \`${params.volScore.toFixed(4)}\``
                : undefined,
            params.zScore !== undefined ? `zScore: \`${params.zScore.toFixed(2)}\`` : undefined,
            params.liquidity !== undefined
                ? `liquidity: \`$${params.liquidity.toLocaleString()}\``
                : undefined,
            params.mcap !== undefined ? `mcap: \`$${params.mcap.toLocaleString()}\`` : undefined,
            params.ageHours !== undefined ? `age: \`${params.ageHours.toFixed(2)}h\`` : undefined,
            params.whaleSignalScore !== undefined
                ? `whaleSignalScore: \`${params.whaleSignalScore.toFixed(1)}\``
                : undefined,
        ].filter(Boolean);
        const metricsBlock =
            metricsLines.length > 0 ? `\nCurrent:\n${metricsLines.join('\n')}\n` : '';
        const title =
            mapping.status === 'WAITING'
                ? 'WATCHLIST UPDATE'
                : mapping.status === 'BLOCKED'
                  ? 'WATCHLIST BLOCKED'
                  : 'WATCHLIST REJECTED';

        const message =
            `*${title}*\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Token: ${displaySymbol}\n` +
            `Mint: \`${params.tokenMint}\`\n` +
            routeLine +
            `Status: \`${mapping.label}\`\n` +
            `Severity: \`${mapping.severity}\`\n` +
            retryLine +
            `\nReason:\n${mapping.message}\n` +
            metricsBlock +
            `\nAction:\n${mapping.action}`;

        await this.sendMessage(message);
    }
    async sendWatchlistNotification(
        tokenMint: string,
        mcap: number,
        ageHours: number,
        symbol?: string,
        surge?: number,
        isCTO?: boolean,
    ) {
        const displaySymbol = symbol || 'UNKNOWN';
        const surgeDisplay = surge ? `🌊 *Surge:* \`${surge.toFixed(2)}x\`` : '🌊 *Surge:* `N/A`';
        const title = isCTO ? `🕵️‍♂️ *CTO CANDIDATE DETECTED* 🕵️‍♂️` : `🔍 *SECOND-WAVE RADAR* 🔍`;

        const message =
            `${title}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💎 *Token:* ${displaySymbol}\n` +
            `🆔 *Mint:* \`${tokenMint}\`\n` +
            `━━━━━━━ 📈 ━━━━━━━\n` +
            `💹 *MCap:* \`$${mcap.toLocaleString()}\`\n` +
            `${surgeDisplay}\n` +
            `⏳ *Age:* \`${ageHours.toFixed(2)}h\`\n` +
            `━━━━━━━ 🛡️ ━━━━━━━\n` +
            `✅ *Status:* MONITORING...`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '💊 Pump.fun', url: `https://pump.fun/coin/${tokenMint}` },
                { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${tokenMint}` },
            ],
            [{ text: '🛡️ RugCheck', url: `https://rugcheck.xyz/tokens/${tokenMint}` }],
        ];

        await this.sendMessage(message, {
            reply_markup: {
                inline_keyboard: buttons,
            },
        });
    }

    private async sendMessage(
        message: string,
        options: TelegramBot.SendMessageOptions = {},
        retryCount = 0,
        targetChatId?: string,
    ) {
        const destinationChatIds = targetChatId
            ? [targetChatId]
            : await this.telegramWorkspace.getActiveChatIds();

        if (this.bot && destinationChatIds.length > 0) {
            for (const destinationChatId of destinationChatIds) {
                await this.sendMessageToChat(destinationChatId, message, options, retryCount);
            }
        } else {
            this.logger.log(`[ALERT]: ${message.replace(/\n/g, ' | ')}`);
        }
    }

    private async sendMessageToChat(
        destinationChatId: string,
        message: string,
        options: TelegramBot.SendMessageOptions,
        retryCount = 0,
    ) {
        try {
            const hasExplicitParseMode = Object.prototype.hasOwnProperty.call(
                options,
                'parse_mode',
            );
            const sendOptions = hasExplicitParseMode
                ? options
                : {
                      parse_mode: 'Markdown' as const,
                      ...options,
                  };

            await this.bot.sendMessage(destinationChatId, message, sendOptions);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);

            if (
                retryCount < 3 &&
                (errorMsg.includes('socket hang up') ||
                    errorMsg.includes('ECONNRESET') ||
                    errorMsg.includes('ETIMEDOUT'))
            ) {
                const delay = (retryCount + 1) * 2000;
                this.logger.warn(
                    `Telegram send failed (${errorMsg}). Retrying in ${delay}ms... (Attempt ${retryCount + 1}/3)`,
                );
                await new Promise((res) => setTimeout(res, delay));
                return this.sendMessageToChat(destinationChatId, message, options, retryCount + 1);
            }

            this.logger.error(
                `Failed to send telegram message to chat ${destinationChatId} after retries: ${errorMsg}`,
            );
        }
    }

    /**
     * Daily P&L Summary — Sent every day at midnight UTC
     */
    @Cron('0 0 * * *')
    async sendDailyPnLSummary() {
        try {
            const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const trades = await this.prismaService.trade.findMany({
                where: {
                    status: 'CLOSED',
                    mode: 'LIVE',
                    updatedAt: { gte: dayAgo },
                },
                include: {
                    telegramChat: { select: { chatId: true } },
                },
            });

            if (trades.length === 0) {
                await this.sendMessage(
                    '📊 *Daily Summary:* No trades closed in the last 24 hours.',
                );
                return;
            }

            const tradesByChat = new Map<string | undefined, typeof trades>();
            for (const trade of trades) {
                const targetChatId = trade.telegramChat?.chatId;
                const scopedTrades = tradesByChat.get(targetChatId) || [];
                scopedTrades.push(trade);
                tradesByChat.set(targetChatId, scopedTrades);
            }

            for (const scopedTrades of tradesByChat.values()) {
                const targetChatId = scopedTrades[0]?.telegramChat?.chatId;
                const trades = scopedTrades;

            const net = (t: {
                profitUsd?: number | null;
                totalFeesSol?: number | null;
                solPriceAtEntry?: number | null;
            }) => computeNetProfitUsd(t);
            const totalPnl = trades.reduce((sum, t) => sum + net(t), 0);
            const wins = trades.filter((t) => net(t) > 0).length;
            const losses = trades.filter((t) => net(t) <= 0).length;
            const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '0';
            const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;

            const bestTrade = trades.reduce((best, t) => (net(t) > net(best) ? t : best), trades[0]);
            const worstTrade = trades.reduce((worst, t) => (net(t) < net(worst) ? t : worst), trades[0]);

            const pnlEmoji = totalPnl >= 0 ? '💰' : '🔻';
            const message =
                `📊 *DAILY P&L SUMMARY* 📊\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `${pnlEmoji} *Total P&L:* \`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\`\n` +
                `📈 *Trades:* \`${trades.length}\` (✅ ${wins} wins | ❌ ${losses} losses)\n` +
                `🎯 *Win Rate:* \`${winRate}%\`\n` +
                `📉 *Avg P&L:* \`${avgPnl >= 0 ? '+' : ''}$${avgPnl.toFixed(2)}\`\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `🏆 *Best:* ${bestTrade.symbol || 'N/A'} (\`+$${net(bestTrade).toFixed(2)}\`)\n` +
                `💀 *Worst:* ${worstTrade.symbol || 'N/A'} (\`$${net(worstTrade).toFixed(2)}\`)\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                this.getExitReasonBreakdown(trades);

            await this.sendMessage(message, {}, 0, targetChatId);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to send daily P&L summary: ${msg}`);
        }
    }

    private getExitReasonBreakdown(trades: Array<{ exitReason?: string | null }>): string {
        const reasons: Record<string, number> = {};
        for (const t of trades) {
            const reason = t.exitReason || 'UNKNOWN';
            reasons[reason] = (reasons[reason] || 0) + 1;
        }
        return Object.entries(reasons)
            .map(([reason, count]) => `⚡ ${reason.replace(/_/g, ' ')}: \`${count}\``)
            .join('\n');
    }

    /**
     * Helper to resolve DNS using Cloudflare/Google DNS-over-HTTPS if standard lookup fails
     */
    private async resolveDns(hostname: string): Promise<string | null> {
        if (this.ipCache[hostname]) return this.ipCache[hostname];

        try {
            this.logger.log(`[DNS] Resolving ${hostname} via Cloudflare/Google DoH...`);
            // Try Cloudflare first
            let response = await axios
                .get(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
                    headers: { accept: 'application/dns-json' },
                    timeout: 5000,
                    httpsAgent: new https.Agent({ family: 4 }),
                })
                .catch(() => null);

            // If Cloudflare fails, try Google
            if (!response) {
                response = await axios
                    .get(`https://8.8.8.8/resolve?name=${hostname}&type=A`, {
                        timeout: 5000,
                        httpsAgent: new https.Agent({ family: 4 }),
                    })
                    .catch(() => null);
            }

            const ip = response?.data?.Answer?.[0]?.data;
            if (ip && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
                this.logger.log(`[DNS] Resolved ${hostname} to ${ip}`);
                this.ipCache[hostname] = ip;
                return ip;
            }
        } catch {
            // Silence DNS errors
        }

        return null;
    }
}
