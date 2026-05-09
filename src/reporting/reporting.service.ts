import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as TelegramBot from 'node-telegram-bot-api';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

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
            const keypair = require('@solana/web3.js').Keypair.fromSecretKey(secretKey);
            this.walletPublicKey = keypair.publicKey.toBase58();
        } catch (e) {}
    }

    if (token && token !== 'your_telegram_bot_token') {
      this.bot = new TelegramBot(token, { polling: true });
      this.logger.log('Telegram bot initialized with polling enabled');
    } else {
      this.logger.warn('Telegram bot token not provided. Alerts will be logged to console only.');
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
        await this.sendMessage(`🤖 *Solana Scalper Bot Active*\n\nAvailable commands:\n/status - Check open positions\n/balance - Check wallet balance\n/help - Show this message`);
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

    let statusMsg = '📊 *Current Portfolio:*\n\n';
    openTrades.forEach((trade, index) => {
      statusMsg += `Slot ${trade.slotNumber}: \`${trade.tokenMint}\`\n`;
      statusMsg += `Entry: \`$${trade.entryPrice}\` | Current: (Calculating...)\n`;
      statusMsg += `Stop: \`$${trade.trailingStopPrice.toFixed(6)}\`\n\n`;
    });

    await this.sendMessage(statusMsg);
  }

  private async handleBalanceRequest() {
    if (!this.connection || !this.walletPublicKey) {
        await this.sendMessage('❌ Wallet/Connection not configured.');
        return;
    }

    try {
        const balance = await this.connection.getBalance(new PublicKey(this.walletPublicKey));
        const solBalance = balance / 1_000_000_000;
        await this.sendMessage(`💰 *Wallet Balance:*\nAddress: \`${this.walletPublicKey}\`\nBalance: \`${solBalance.toFixed(4)} SOL\``);
    } catch (error) {
        await this.sendMessage(`❌ Error fetching balance: ${error.message}`);
    }
  }

  async sendBuyAlert(tokenMint: string, price: number, slotUsed: number) {
    const message = `🚀 *BUY ALERT*\nToken: \`${tokenMint}\`\nPrice: \`$${price}\`\nSlot Used: \`${slotUsed}\``;
    await this.sendMessage(message);
  }

  async sendTrailingAlert(tokenMint: string, newStopPrice: number, currentPrice: number) {
    const message = `📈 *TRAILING STOP UPDATED*\nToken: \`${tokenMint}\`\nNew Stop: \`$${newStopPrice}\`\nCurrent Price: \`$${currentPrice}\``;
    await this.sendMessage(message);
  }

  async sendSellAlert(tokenMint: string, sellPrice: number, netProfitPercent: number, isStopLoss: boolean) {
    const emoji = netProfitPercent >= 0 ? '💰' : '🛑';
    const reason = isStopLoss ? 'Stop Loss Triggered' : 'Take Profit Triggered';
    const message = `${emoji} *SELL ALERT* (${reason})\nToken: \`${tokenMint}\`\nSell Price: \`$${sellPrice}\`\nNet Profit: \`${netProfitPercent}%\``;
    await this.sendMessage(message);
  }

  private async sendMessage(message: string) {
    if (this.bot && this.chatId) {
      try {
        await this.bot.sendMessage(this.chatId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        this.logger.error(`Failed to send telegram message: ${error.message}`);
      }
    } else {
      this.logger.log(`[ALERT]: ${message.replace(/\n/g, ' | ')}`);
    }
  }
}
