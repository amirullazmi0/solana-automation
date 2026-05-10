import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as TelegramBot from 'node-telegram-bot-api';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';

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

            if (text === '/start' || text === '/help') {
                await this.sendMessage(
                    `🤖 *Solana Scalper Bot Active*\n\nAvailable commands:\n/status - Check open positions\n/balance - Check wallet balance\n/help - Show this message`,
                );
            } else if (text === '/status') {
                await this.handleStatusRequest();
            } else if (text === '/balance') {
                await this.handleBalanceRequest();
            }
        });
    }

    private async handleStatusRequest() {
        const openTrades = await this.prismaService.trade.findMany({
            where: { status: 'OPEN' },
        });

        if (openTrades.length === 0) {
            await this.sendMessage('📭 *No open positions currently.*');
            return;
        }

        await this.sendMessage('🔍 *Fetching real-time prices, please wait...*');

        let statusMsg = '📊 *Current Portfolio:*\n\n';
        
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

    private async fetchCurrentPrice(tokenMint: string): Promise<number | null> {
        try {
            // Coba Jupiter dulu (Metis/Paid)
            const apiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
            const response = await axios.get(`https://api.jup.ag/price/v2?ids=${tokenMint}`, {
                timeout: 5000,
                headers: { 'x-api-key': apiKey }
            }).catch(() => null);

            if (response?.data?.data?.[tokenMint]?.price) {
                return parseFloat(response.data.data[tokenMint].price);
            }

            // Fallback ke DexScreener
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

    async sendBuyAlert(tokenMint: string, price: number, slotUsed: number, symbol?: string) {
        const displaySymbol = symbol || 'UNKNOWN';
        const message = `🚀 *BUY ALERT*\nToken: *${displaySymbol}*\nMint: \`${tokenMint}\`\nPrice: \`$${price.toFixed(8)}\`\nSlot Used: \`${slotUsed}\``;
        await this.sendMessage(message);
    }

    async sendTrailingAlert(tokenMint: string, newStopPrice: number, currentPrice: number, symbol?: string) {
        const displaySymbol = symbol || 'UNKNOWN';
        const message = `📈 *TRAILING STOP UPDATED*\nToken: *${displaySymbol}*\nNew Stop: \`$${newStopPrice.toFixed(8)}\`\nCurrent Price: \`$${currentPrice.toFixed(8)}\``;
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
        const reason = isStopLoss ? 'Stop Loss Triggered' : 'Take Profit Triggered';
        const message = `${emoji} *SELL ALERT* (${reason})\nToken: *${displaySymbol}*\nSell Price: \`$${sellPrice.toFixed(8)}\`\nNet Profit: \`${netProfitPercent.toFixed(2)}%\``;
        await this.sendMessage(message);
    }

    private async sendMessage(message: string) {
        if (this.bot && this.chatId) {
            try {
                await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(`Failed to send telegram message: ${message}`);
            }
        } else {
            this.logger.log(`[ALERT]: ${message.replace(/\n/g, ' | ')}`);
        }
    }
}
