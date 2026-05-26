import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import * as TelegramBot from 'node-telegram-bot-api';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';
import * as https from 'https';
import { TokenMetadata } from '../analyzer/analyzer.service';
import { ModuleRef } from '@nestjs/core';
import { TradeService } from '../trade/trade.service';
import { ScannerService } from '../scanner/scanner.service';
import { DexLimiter } from '../common/dex-limiter';

@Injectable()
export class ReportingService implements OnModuleInit {
    private readonly logger = new Logger(ReportingService.name);
    private readonly bot: TelegramBot;
    private readonly chatId: string;
    private readonly connection: Connection;
    private readonly walletPublicKey: string;
    private readonly isDryRun: boolean;
    private readonly httpsAgent: https.Agent;

    // Cache for resolved IPs
    private ipCache: Record<string, string> = {
        '1.1.1.1': '1.1.1.1',
        '8.8.8.8': '8.8.8.8',
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly moduleRef: ModuleRef,
    ) {
        const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
        this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';
        this.isDryRun = this.configService.get<string>('DRY_RUN') === 'true';

        const rpcEndpoint = this.configService.get<string>('RPC_ENDPOINT');
        if (rpcEndpoint) {
            this.connection = new Connection(rpcEndpoint, 'confirmed');
        }

        const privateKey = this.configService.get<string>('PRIVATE_KEY');
        if (privateKey && privateKey !== 'YOUR_BASE58_PRIVATE_KEY_HERE') {
            try {
                const secretKey = bs58.decode(privateKey);
                const keypair = Keypair.fromSecretKey(secretKey);
                this.walletPublicKey = keypair.publicKey.toBase58();
            } catch {
                // Silently fail
            }
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

            // Security check: Only respond to the owner
            if (incomingChatId !== this.chatId) {
                this.logger.warn(`Unauthorized access attempt from Chat ID: ${incomingChatId}`);
                return;
            }

            if (!text) return;

            if (text === '/start' || text === '/help') {
                await this.sendMainMenu();
            } else if (text === '/status' || text === '📊 Status') {
                await this.handleStatusRequest();
            } else if (text === '/balance' || text === '💰 Balance') {
                await this.handleBalanceRequest();
            } else if (text === '🔍 Watchlist') {
                await this.handleWatchlistRequest();
            } else if (this.isSolanaAddress(text)) {
                await this.handleTokenInput(text);
            }
        });

        this.bot.on('callback_query', async (query) => {
            await this.handleCallbackQuery(query);
        });
    }

    private isSolanaAddress(text: string): boolean {
        return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
    }

    private async sendMainMenu() {
        const message =
            `🤖 *Solana Trend Follower Bot Active*\n\n` +
            `Selamat datang Amirull! Pilih menu di bawah untuk mengelola bot kamu.`;

        const options: TelegramBot.SendMessageOptions = {
            reply_markup: {
                keyboard: [
                    [{ text: '📊 Status' }, { text: '💰 Balance' }],
                    [{ text: '🔍 Watchlist' }],
                ],
                resize_keyboard: true,
            },
        };

        await this.sendMessage(message, options);
    }

    private async handleWatchlistRequest() {
        const pendingWatchlist = await this.prismaService.watchlist.findMany({
            where: { status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
            take: 10,
        });

        if (pendingWatchlist.length === 0) {
            await this.sendMessage(
                '🔍 *Watchlist Kosong.* Saat ini tidak ada token yang dipantau.',
            );
            return;
        }

        await this.sendMessage(`🔍 *Menampilkan ${pendingWatchlist.length} token di Watchlist...*`);

        for (const item of pendingWatchlist) {
            const symbol = item.symbol || 'UNKNOWN';
            let msg = `💎 *${symbol}*\n`;
            msg += `🆔 \`${item.tokenMint}\`\n`;
            msg += `💹 MCap: \`$${item.mcap?.toLocaleString()}\` | Surge: \`${item.volumeSurge?.toFixed(1)}x\`\n`;

            const buttons: TelegramBot.InlineKeyboardButton[][] = [
                [
                    { text: '💊 Pump.fun', url: `https://pump.fun/coin/${item.tokenMint}` },
                    {
                        text: '📊 DexScreener',
                        url: `https://dexscreener.com/solana/${item.tokenMint}`,
                    },
                ],
            ];

            await this.sendMessage(msg, {
                reply_markup: { inline_keyboard: buttons },
            });
        }
    }

    private async handleTokenInput(mint: string) {
        const symbol = await this.fetchTokenSymbolFromDex(mint);
        const message =
            `🎯 *Token Detected: ${symbol}*\n` +
            `🆔 \`${mint}\`\n\n` +
            `Apa yang ingin kamu lakukan dengan token ini?`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '💵 Buy', callback_data: `buy_menu:${mint}` },
                { text: '💸 Sell', callback_data: `sell_menu:${mint}` },
            ],
            [
                { text: '🛡️ RugCheck', url: `https://rugcheck.xyz/tokens/${mint}` },
                { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${mint}` },
            ],
        ];

        await this.sendMessage(message, {
            reply_markup: { inline_keyboard: buttons },
        });
    }

    private async handleCallbackQuery(query: TelegramBot.CallbackQuery) {
        const data = query.data;
        if (!data) return;

        const [action, payload] = data.split(':');

        if (action === 'buy_menu') {
            await this.sendBuyMenu(payload);
        } else if (action === 'sell_menu') {
            await this.sendSellMenu(payload);
        } else if (action === 'buy_exec') {
            const [mint, amount] = payload.split('|');
            await this.executeManualBuy(mint, Number.parseFloat(amount));
        } else if (action === 'sell_exec') {
            const [mint, percent] = payload.split('|');
            await this.executeManualSell(mint, Number.parseFloat(percent));
        }

        // Answer callback to remove loading state
        await this.bot.answerCallbackQuery(query.id);
    }

    private async sendBuyMenu(mint: string) {
        const message = `💵 *Pilih Jumlah Buy ($USD):*\nToken: \`${mint}\``;
        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '$5', callback_data: `buy_exec:${mint}|5` },
                { text: '$10', callback_data: `buy_exec:${mint}|10` },
            ],
            [
                { text: '$15', callback_data: `buy_exec:${mint}|15` },
                { text: '$20', callback_data: `buy_exec:${mint}|20` },
            ],
        ];

        await this.sendMessage(message, {
            reply_markup: { inline_keyboard: buttons },
        });
    }

    private async sendSellMenu(mint: string) {
        const message = `💸 *Pilih Persentase Sell:*\nToken: \`${mint}\``;
        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '25%', callback_data: `sell_exec:${mint}|0.25` },
                { text: '50%', callback_data: `sell_exec:${mint}|0.5` },
            ],
            [
                { text: '75%', callback_data: `sell_exec:${mint}|0.75` },
                { text: '100%', callback_data: `sell_exec:${mint}|1.0` },
            ],
        ];

        await this.sendMessage(message, {
            reply_markup: { inline_keyboard: buttons },
        });
    }

    private async executeManualBuy(mint: string, amount: number) {
        await this.sendMessage(`⏳ *Memproses Buy $${amount}...*`);
        try {
            const tradeService = this.moduleRef.get(TradeService, { strict: false });
            const result = await tradeService.handleManualBuy(mint, amount);
            if (result.success) {
                await this.sendMessage(`✅ *Success:* ${result.message}`);
            } else {
                await this.sendMessage(`❌ *Failed:* ${result.message}`);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await this.sendMessage(`❌ *Error:* ${msg}`);
        }
    }

    private async executeManualSell(mint: string, percent: number) {
        await this.sendMessage(`⏳ *Memproses Sell ${(percent * 100).toFixed(0)}%...*`);
        try {
            const tradeService = this.moduleRef.get(TradeService, { strict: false });
            const result = await tradeService.handleManualSell(mint, percent);
            if (result.success) {
                await this.sendMessage(`✅ *Success:* ${result.message}`);
            } else {
                await this.sendMessage(`❌ *Failed:* ${result.message}`);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await this.sendMessage(`❌ *Error:* ${msg}`);
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

    async handleStatusRequest() {
        const openTrades = await this.prismaService.trade.findMany({
            where: { status: 'OPEN' },
        });

        if (openTrades.length === 0) {
            await this.sendMessage('📭 *No open positions currently.*');
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
            where: { status: 'CLOSED' },
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

        await this.sendMessage(statusMsg);
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

    private async handleBalanceRequest() {
        if (!this.connection || !this.walletPublicKey) {
            await this.sendMessage('❌ Wallet/Connection not configured.');
            return;
        }

        try {
            const balance = await this.connection.getBalance(new PublicKey(this.walletPublicKey));
            const solBalance = balance / 1_000_000_000;
            await this.sendMessage(
                `💰 *Wallet Balance:*\nAddress: \`${this.walletPublicKey}\`\nBalance: \`${solBalance.toFixed(4)} SOL\``,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.sendMessage(`❌ Error fetching balance: ${message}`);
        }
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
    ) {
        const displaySymbol = symbol || 'UNKNOWN';
        const prefix = this.isDryRun ? '🤖 [SIMULASI] ' : '🚀 ';
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

        await this.sendMessage(message, options);
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
    ) {
        const displaySymbol = symbol || 'UNKNOWN';
        const isSuccess = netProfitPercent >= 0;
        const emoji = isSuccess ? '💰' : '🛑';
        const profitEmoji = isSuccess ? '🟢' : '🔴';
        const prefix = this.isDryRun ? '🤖 [SIMULASI] ' : '';

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

        await this.sendMessage(message, {
            reply_markup: { inline_keyboard: [buttons] },
        });
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
    ) {
        const displaySymbol = metadata?.symbol || 'UNKNOWN';
        const strategy =
            options?.strategy || (metadata?.isCTO ? 'CTO Candidate' : 'Standard Second-Wave');
        const exitPlan = options
            ? `\nTarget: TP ${options.targetTakeProfit}% | TSL ${options.targetTrailingDistance}% | SL ${options.targetStopLoss}%`
            : '';

        const message =
            `*MUST BUY SIGNAL - NO AUTO BUY*\n` +
            `Token: ${displaySymbol}\n` +
            `Mint: \`${tokenMint}\`\n` +
            `Strategy: \`${strategy}\`${exitPlan}\n\n` +
            `MCap: \`$${(metadata?.mcap || metadata?.marketCap || 0).toLocaleString()}\`\n` +
            `Liquidity: \`$${(metadata?.liquidity || 0).toLocaleString()}\`\n` +
            `Surge: \`${metadata?.volumeSurge?.toFixed(2) || 'N/A'}x\`\n` +
            `VoL: \`${metadata?.volScore?.toFixed(4) || 'N/A'}\` | Z: \`${metadata?.zScore?.toFixed(2) || 'N/A'}\`\n\n` +
            `Mode: \`Signal only. Bot did not execute swap.\``;

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

        await this.sendMessage(message, {
            reply_markup: { inline_keyboard: buttons },
        });
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
    ) {
        if (this.bot && this.chatId) {
            try {
                await this.bot.sendMessage(this.chatId, message, {
                    parse_mode: 'Markdown',
                    ...options,
                });
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);

                // 🔄 RETRY LOGIC: Kalau socket hang up atau timeout, coba lagi sampe 3x
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
                    return this.sendMessage(message, options, retryCount + 1);
                }

                this.logger.error(`Failed to send telegram message after retries: ${errorMsg}`);
            }
        } else {
            this.logger.log(`[ALERT]: ${message.replace(/\n/g, ' | ')}`);
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
                    updatedAt: { gte: dayAgo },
                },
            });

            if (trades.length === 0) {
                await this.sendMessage(
                    '📊 *Daily Summary:* No trades closed in the last 24 hours.',
                );
                return;
            }

            const totalPnl = trades.reduce((sum, t) => sum + (t.profitUsd || 0), 0);
            const wins = trades.filter((t) => (t.profitUsd || 0) > 0).length;
            const losses = trades.filter((t) => (t.profitUsd || 0) <= 0).length;
            const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '0';
            const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;

            const bestTrade = trades.reduce(
                (best, t) => ((t.profitUsd || 0) > (best.profitUsd || 0) ? t : best),
                trades[0],
            );
            const worstTrade = trades.reduce(
                (worst, t) => ((t.profitUsd || 0) < (worst.profitUsd || 0) ? t : worst),
                trades[0],
            );

            const pnlEmoji = totalPnl >= 0 ? '💰' : '🔻';
            const message =
                `📊 *DAILY P&L SUMMARY* 📊\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `${pnlEmoji} *Total P&L:* \`${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}\`\n` +
                `📈 *Trades:* \`${trades.length}\` (✅ ${wins} wins | ❌ ${losses} losses)\n` +
                `🎯 *Win Rate:* \`${winRate}%\`\n` +
                `📉 *Avg P&L:* \`${avgPnl >= 0 ? '+' : ''}$${avgPnl.toFixed(2)}\`\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `🏆 *Best:* ${bestTrade.symbol || 'N/A'} (\`+$${(bestTrade.profitUsd || 0).toFixed(2)}\`)\n` +
                `💀 *Worst:* ${worstTrade.symbol || 'N/A'} (\`$${(worstTrade.profitUsd || 0).toFixed(2)}\`)\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                this.getExitReasonBreakdown(trades);

            await this.sendMessage(message);
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
