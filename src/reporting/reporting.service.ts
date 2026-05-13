import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as TelegramBot from 'node-telegram-bot-api';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';
import { TokenMetadata } from '../analyzer/analyzer.service';
import { ModuleRef } from '@nestjs/core';
import { TradeService } from '../trade/trade.service';
import { ScannerService } from '../scanner/scanner.service';

@Injectable()
export class ReportingService implements OnModuleInit {
    private readonly logger = new Logger(ReportingService.name);
    private bot: TelegramBot;
    private chatId: string;
    private connection: Connection;
    private walletPublicKey: string;

    constructor(
        private configService: ConfigService,
        private prismaService: PrismaService,
        private moduleRef: ModuleRef,
    ) {
        const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
        this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';

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
            } else if (text === '💼 Portfolio') {
                await this.handlePortfolioRequest();
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
        const message = `🤖 *Solana Trend Follower Bot Active*\n\n` +
                        `Selamat datang Amirull! Pilih menu di bawah untuk mengelola bot kamu.`;
        
        const options: TelegramBot.SendMessageOptions = {
            reply_markup: {
                keyboard: [
                    [{ text: '📊 Status' }, { text: '💰 Balance' }],
                    [{ text: '🔍 Watchlist' }, { text: '💼 Portfolio' }]
                ],
                resize_keyboard: true
            }
        };

        await this.sendMessage(message, options);
    }

    private async handleWatchlistRequest() {
        const pendingWatchlist = await this.prismaService.watchlist.findMany({
            where: { status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
            take: 10
        });

        if (pendingWatchlist.length === 0) {
            await this.sendMessage('🔍 *Watchlist Kosong.* Saat ini tidak ada token yang dipantau.');
            return;
        }

        let msg = '🔍 *Pending Watchlist:*\n\n';
        for (const item of pendingWatchlist) {
            const symbol = item.symbol || 'UNKNOWN';
            msg += `💎 *${symbol}*\n`;
            msg += `🆔 \`${item.tokenMint}\`\n`;
            msg += `💹 MCap: \`$${item.mcap?.toLocaleString()}\` | Surge: \`${item.volumeSurge?.toFixed(1)}x\`\n`;
            msg += `━━━━━━━━━━━━━━━━━━\n`;
        }

        await this.sendMessage(msg);
    }

    async handlePortfolioRequest() {
        const tradeService = this.moduleRef.get(TradeService, { strict: false });
        const holdings = await tradeService.getWalletHoldings();

        if (holdings.length === 0) {
            await this.sendMessage('💼 *Portfolio Kosong.* Tidak ada token ditemukan di wallet kamu.');
            return;
        }

        await this.sendMessage(`💼 *Menampilkan ${holdings.length} holdings dari wallet kamu...*`);

        for (const holding of holdings) {
            const currentPrice = await this.fetchCurrentPrice(holding.mint);
            
            // Cari data trade di DB untuk hitung profit
            const trade = await this.prismaService.trade.findFirst({
                where: { tokenMint: holding.mint, status: 'OPEN' },
                orderBy: { createdAt: 'desc' }
            });

            let profitDisplay = 'N/A';
            let emoji = '⚪';
            let entryInfo = '';

            if (trade && currentPrice) {
                const profit = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
                profitDisplay = `${profit >= 0 ? '+' : ''}${profit.toFixed(2)}%`;
                emoji = profit >= 0 ? '📈' : '📉';
                entryInfo = `💰 Entry: \`$${trade.entryPrice.toFixed(8)}\` | `;
            }

            const priceDisplay = currentPrice ? `$${currentPrice.toFixed(8)}` : '(N/A)';

            let msg = `💎 *${holding.symbol}*\n`;
            msg += `🆔 \`${holding.mint}\`\n`;
            msg += `📦 Balance: \`${holding.balance.toLocaleString()}\`\n`;
            msg += `${entryInfo}Price: \`${priceDisplay}\` ${emoji}\n`;
            msg += `📊 Profit: *${profitDisplay}*`;

            const buttons: TelegramBot.InlineKeyboardButton[][] = [
                [
                    { text: '💵 Buy', callback_data: `buy_menu:${holding.mint}` },
                    { text: '💸 Sell', callback_data: `sell_menu:${holding.mint}` }
                ],
                [
                    { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${holding.mint}` }
                ]
            ];

            await this.sendMessage(msg, {
                reply_markup: { inline_keyboard: buttons }
            });
        }
    }

    private async handleTokenInput(mint: string) {
        const symbol = await this.fetchTokenSymbolFromDex(mint);
        const message = `🎯 *Token Detected: ${symbol}*\n` +
                        `🆔 \`${mint}\`\n\n` +
                        `Apa yang ingin kamu lakukan dengan token ini?`;
        
        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '💵 Buy', callback_data: `buy_menu:${mint}` },
                { text: '💸 Sell', callback_data: `sell_menu:${mint}` }
            ],
            [
                { text: '🛡️ RugCheck', url: `https://rugcheck.xyz/tokens/${mint}` },
                { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${mint}` }
            ]
        ];

        await this.sendMessage(message, {
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private async handleCallbackQuery(query: TelegramBot.CallbackQuery) {
        const data = query.data;
        if (!data) return;

        const [action, payload] = data.split(':');
        // const chatId = query.message?.chat.id.toString();

        if (action === 'buy_menu') {
            await this.sendBuyMenu(payload);
        } else if (action === 'sell_menu') {
            await this.sendSellMenu(payload);
        } else if (action === 'buy_exec') {
            const [mint, amount] = payload.split('|');
            await this.executeManualBuy(mint, parseFloat(amount));
        } else if (action === 'sell_exec') {
            const [mint, percent] = payload.split('|');
            await this.executeManualSell(mint, parseFloat(percent));
        }

        // Answer callback to remove loading state
        await this.bot.answerCallbackQuery(query.id);
    }

    private async sendBuyMenu(mint: string) {
        const message = `💵 *Pilih Jumlah Buy ($USD):*\nToken: \`${mint}\``;
        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '$5', callback_data: `buy_exec:${mint}|5` },
                { text: '$10', callback_data: `buy_exec:${mint}|10` }
            ],
            [
                { text: '$15', callback_data: `buy_exec:${mint}|15` },
                { text: '$20', callback_data: `buy_exec:${mint}|20` }
            ]
        ];

        await this.sendMessage(message, {
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private async sendSellMenu(mint: string) {
        const message = `💸 *Pilih Persentase Sell:*\nToken: \`${mint}\``;
        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '25%', callback_data: `sell_exec:${mint}|0.25` },
                { text: '50%', callback_data: `sell_exec:${mint}|0.5` }
            ],
            [
                { text: '75%', callback_data: `sell_exec:${mint}|0.75` },
                { text: '100%', callback_data: `sell_exec:${mint}|1.0` }
            ]
        ];

        await this.sendMessage(message, {
            reply_markup: { inline_keyboard: buttons }
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
            await this.sendMessage(`❌ *Error:* ${error.message}`);
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
            await this.sendMessage(`❌ *Error:* ${error.message}`);
        }
    }

    private async fetchTokenSymbolFromDex(tokenMint: string): Promise<string> {
        try {
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
                timeout: 5000,
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
            const profitDisplay = currentPrice ? `${profit >= 0 ? '+' : ''}${profit.toFixed(2)}%` : '(N/A)';
            const emoji = profit >= 0 ? '📈' : '📉';
            const displaySymbol = trade.symbol && trade.symbol !== 'UNKNOWN' ? trade.symbol : 'UNKNOWN';

            statusMsg += `Slot ${trade.slotNumber}: *${displaySymbol}*\n`;
            statusMsg += `Mint: \`${trade.tokenMint}\`\n`;
            statusMsg += `Entry: \`$${trade.entryPrice.toFixed(8)}\` | Current: \`${priceDisplay}\` ${emoji}\n`;
            statusMsg += `Profit/Loss: *${profitDisplay}*\n`;
            statusMsg += `Stop: \`$${trade.trailingStopPrice.toFixed(8)}\`\n\n`;
        }

        await this.sendMessage(statusMsg);
    }

    async fetchCurrentPrice(tokenMint: string): Promise<number | null> {
        try {
            const apiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
            const response = await axios.get(`https://api.jup.ag/price/v2?ids=${tokenMint}`, {
                timeout: 5000,
                headers: { 'x-api-key': apiKey }
            }).catch(() => null);

            if (response?.data?.data?.[tokenMint]?.price) {
                return parseFloat(response.data.data[tokenMint].price);
            }

            const dexResponse = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
                timeout: 5000
            }).catch(() => null);

            if (dexResponse?.data?.pairs?.[0]?.priceUsd) {
                return parseFloat(dexResponse.data.pairs[0].priceUsd);
            }
        } catch (error) {
            this.logger.error(`Error fetching price for report: ${error.message}`);
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
        socials?: TokenMetadata['socials']
    ) {
        const displaySymbol = symbol || 'UNKNOWN';
        const message = `🚀 *SOLANA BUY ALERT* 🚀\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💎 *Token:* ${displaySymbol}\n` +
                        `🆔 *Mint:* \`${tokenMint}\`\n` +
                        `💰 *Price:* \`$${price.toFixed(8)}\`\n` +
                        `🧱 *Slot:* #${slotUsed}\n` +
                        `━━━━━━━ 📊 ━━━━━━━\n` +
                        `📈 *Action:* BUY EXECUTION`;
        
        const row1: TelegramBot.InlineKeyboardButton[] = [];
        if (socials?.twitter) row1.push({ text: '🐦 Twitter', url: socials.twitter });
        if (socials?.telegram) row1.push({ text: '📱 Telegram', url: socials.telegram });
        
        const row2: TelegramBot.InlineKeyboardButton[] = [
            { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${tokenMint}` },
            { text: '🛡️ RugCheck', url: `https://rugcheck.xyz/tokens/${tokenMint}` }
        ];

        const row3: TelegramBot.InlineKeyboardButton[] = [
            { text: '🔍 Solscan', url: `https://solscan.io/token/${tokenMint}` }
        ];

        const options: TelegramBot.SendMessageOptions = {
            reply_markup: {
                inline_keyboard: [row1, row2, row3].filter(r => r.length > 0)
            }
        };

        await this.sendMessage(message, options);
    }

    async sendTrailingAlert(tokenMint: string, newStopPrice: number, currentPrice: number, symbol?: string) {
        const displaySymbol = symbol || 'UNKNOWN';
        const message = `📈 *TRAILING STOP UPDATED*\n` +
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
        isStopLoss: boolean,
        symbol?: string,
    ) {
        const displaySymbol = symbol || 'UNKNOWN';
        const emoji = netProfitPercent >= 0 ? '💰' : '🛑';
        const action = netProfitPercent >= 0 ? 'TAKE PROFIT' : 'STOP LOSS';
        const profitEmoji = netProfitPercent >= 0 ? '🟢' : '🔴';
        
        const message = `${emoji} *SOLANA SELL ALERT* ${emoji}\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💎 *Token:* ${displaySymbol}\n` +
                        `🆔 *Mint:* \`${tokenMint}\`\n` +
                        `💰 *Sell Price:* \`$${sellPrice.toFixed(8)}\`\n` +
                        `📊 *Result:* ${profitEmoji} *${netProfitPercent.toFixed(2)}%*\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `⚡ *Action:* ${action} TRIGGERED`;

        const buttons: TelegramBot.InlineKeyboardButton[] = [
            { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${tokenMint}` },
            { text: '🔍 Solscan', url: `https://solscan.io/token/${tokenMint}` }
        ];

        await this.sendMessage(message, {
            reply_markup: { inline_keyboard: [buttons] }
        });
    }

    async sendWatchlistNotification(tokenMint: string, mcap: number, ageHours: number, symbol?: string, surge?: number) {
        const displaySymbol = symbol || 'UNKNOWN';
        const surgeDisplay = surge ? `🌊 *Surge:* \`${surge.toFixed(2)}x\`` : '🌊 *Surge:* `N/A`';
        
        const message = `🔍 *SECOND-WAVE RADAR* 🔍\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `💎 *Token:* ${displaySymbol}\n` +
                        `🆔 *Mint:* \`${tokenMint}\`\n` +
                        `━━━━━━━ 📈 ━━━━━━━\n` +
                        `💹 *MCap:* \`$${mcap.toLocaleString()}\`\n` +
                        `${surgeDisplay}\n` +
                        `⏳ *Age:* \`${ageHours.toFixed(1)}h\`\n` +
                        `━━━━━━━ 🛡️ ━━━━━━━\n` +
                        `✅ *Status:* MONITORING...`;
        
        const buttons: TelegramBot.InlineKeyboardButton[] = [
            { text: '📊 DexScreener', url: `https://dexscreener.com/solana/${tokenMint}` },
            { text: '🛡️ RugCheck', url: `https://rugcheck.xyz/tokens/${tokenMint}` }
        ];

        await this.sendMessage(message, {
            reply_markup: {
                inline_keyboard: [buttons]
            }
        });
    }

    private async sendMessage(message: string, options: TelegramBot.SendMessageOptions = {}) {
        if (this.bot && this.chatId) {
            try {
                await this.bot.sendMessage(this.chatId, message, { 
                    parse_mode: 'Markdown',
                    ...options
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(`Failed to send telegram message: ${message}`);
            }
        } else {
            this.logger.log(`[ALERT]: ${message.replace(/\n/g, ' | ')}`);
        }
    }
}
