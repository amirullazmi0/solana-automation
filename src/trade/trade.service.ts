import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PrismaService } from '../prisma/prisma.service';
import { ReportingService } from '../reporting/reporting.service';
import axios from 'axios';
import * as https from 'https';
import { lookup } from 'dns';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

@Injectable()
export class TradeService implements OnModuleInit {
    private readonly logger = new Logger(TradeService.name);
    private connection: Connection;
    private wallet: Keypair;

    private readonly totalCapital: number;
    private readonly reserveAmount: number;
    private readonly totalSlots: number;
    private readonly positionSizeUSD: number;
    private readonly slippageBps: number;

    // Cache for resolved IPs
    private ipCache: Record<string, string> = {
        'quote-api.jup.ag': '104.26.11.233', // Cloudflare IP 1
        'api.jup.ag': '104.26.10.233',      // Cloudflare IP 2
        'tokens.jup.ag': '172.67.74.132',   // Cloudflare IP 3
        '1.1.1.1': '1.1.1.1',
        '8.8.8.8': '8.8.8.8',
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly reportingService: ReportingService,
    ) {
        this.totalCapital = Number.parseFloat(this.configService.get<string>('TOTAL_CAPITAL', '20'));
        this.reserveAmount = Number.parseFloat(this.configService.get<string>('RESERVE_AMOUNT', '5'));
        this.totalSlots = Number.parseInt(this.configService.get<string>('TOTAL_SLOTS', '4'), 10);
        this.positionSizeUSD = (this.totalCapital - this.reserveAmount) / this.totalSlots;
        this.slippageBps = Number.parseInt(this.configService.get<string>('SLIPPAGE_BPS', '100'), 10);

        this.setupWalletAndConnection();
    }

    async onModuleInit() {
        if (this.wallet && this.connection) {
            try {
                const balance = await this.connection.getBalance(this.wallet.publicKey);
                const solBalance = balance / 1_000_000_000;
                this.logger.log(`💰 Current Balance: ${solBalance.toFixed(4)} SOL`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(`Failed to fetch wallet balance: ${message}`);
            }
        }
    }

    private setupWalletAndConnection() {
        const rpcEndpoint = this.configService.get<string>('RPC_ENDPOINT');
        if (rpcEndpoint) {
            this.connection = new Connection(rpcEndpoint, 'confirmed');
        }

        const privateKeyString = this.configService.get<string>('PRIVATE_KEY');
        if (privateKeyString) {
            try {
                const secretKey = bs58.decode(privateKeyString);
                this.wallet = Keypair.fromSecretKey(secretKey);
                this.logger.log(`Wallet loaded: ${this.wallet.publicKey.toBase58()}`);
            } catch (error) {
                this.logger.error(`Failed to decode private key: ${error.message}`);
            }
        }
    }

    /**
     * Helper to resolve DNS using Google DNS-over-HTTPS if standard lookup fails
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

    async attemptBuy(tokenMint: string): Promise<{ success: boolean; message: string }> {
        const openTradesCount = await this.prismaService.trade.count({ where: { status: 'OPEN' } });
        if (openTradesCount >= this.totalSlots) {
            return { success: false, message: 'All trading slots are full.' };
        }

        const openTrades = await this.prismaService.trade.findMany({
            where: { status: 'OPEN' },
            select: { slotNumber: true },
        });

        const usedSlots = new Set(openTrades.map((t) => t.slotNumber));
        let slotToUse = 1;
        for (let i = 1; i <= this.totalSlots; i++) {
            if (!usedSlots.has(i)) {
                slotToUse = i;
                break;
            }
        }

        // Calculate amount in SOL (Price is currently hardcoded for estimation)
        const amountInSol = this.positionSizeUSD / 150; 
        const amountInLamports = Math.floor(amountInSol * 1_000_000_000);

        this.logger.log(`[Slot ${slotToUse}] Attempting to buy ${tokenMint} with ${amountInSol.toFixed(4)} SOL`);

        const { success, entryPrice, error } = await this.executeJupiterSwap(
            WRAPPED_SOL_MINT,
            tokenMint,
            amountInLamports,
            'BUY',
        );

        if (success && entryPrice > 0) {
            await this.prismaService.trade.create({
                data: {
                    tokenMint,
                    slotNumber: slotToUse,
                    entryPrice,
                    highestPrice: entryPrice,
                    trailingStopPrice: entryPrice * 0.9,
                    status: 'OPEN',
                    amountInSol,
                },
            });
            this.logger.log(`[Slot ${slotToUse}] Successfully bought ${tokenMint}`);
            await this.reportingService.sendBuyAlert(tokenMint, entryPrice, slotToUse);
            return { success: true, message: `Successfully bought ${tokenMint} at slot ${slotToUse}` };
        }

        return { success: false, message: `Swap failed: ${error || 'Unknown error'}` };
    }

    async executeSell(tradeId: number, currentPrice: number, isStopLoss: boolean) {
        const trade = await this.prismaService.trade.findUnique({ where: { id: tradeId } });
        if (!trade || trade.status !== 'OPEN') return;

        const tokenAmountToSell = Math.floor((this.positionSizeUSD / trade.entryPrice) * 1_000_000);
        const { success } = await this.executeJupiterSwap(
            trade.tokenMint,
            WRAPPED_SOL_MINT,
            tokenAmountToSell,
            'SELL',
        );

        if (success) {
            await this.prismaService.trade.update({
                where: { id: tradeId },
                data: { status: 'CLOSED' },
            });
            const profit = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
            await this.reportingService.sendSellAlert(
                trade.tokenMint,
                currentPrice,
                profit,
                isStopLoss,
            );
        }
    }

    private async executeJupiterSwap(
        inputMint: string,
        outputMint: string,
        amount: number,
        side: 'BUY' | 'SELL',
        retryCount = 0,
    ): Promise<{ success: boolean; entryPrice: number; error?: string }> {
        try {
            if (retryCount === 0) await new Promise((res) => setTimeout(res, Math.random() * 2000));

            // Jurus Pamungkas: Override DNS di level Node.js
            const hostname = 'quote-api.jup.ag';
            const baseUrl = `https://${hostname}`;

            this.logger.log(`[Jupiter] Fetching quote for ${side} (Attempt ${retryCount + 1})...`);

            const config = {
                timeout: 20000,
                headers: { 
                    'Accept-Encoding': 'gzip, deflate, br' 
                },
                httpsAgent: new https.Agent({
                    family: 4,
                    // Kita paksa Node.js cari IP lewat DoH kita sendiri
                    lookup: async (h, o, cb) => {
                        try {
                            const ip = await this.resolveDns(h);
                            if (ip) {
                                cb(null, ip, 4);
                            } else {
                                // Fallback ke system DNS jika DoH gagal
                                lookup(h, o, cb);
                            }
                        } catch (e) {
                            cb(e as Error, '', 4);
                        }
                    }
                }),
            };

            const quoteUrl = `${baseUrl}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.slippageBps}`;
            const quoteResponse = await axios.get(quoteUrl, config);
            const quoteData = quoteResponse.data;

            let entryPrice = 0;
            if (side === 'BUY') {
                entryPrice = this.positionSizeUSD / (quoteData.outAmount / 1_000_000);
            }

            const swapResponse = await axios.post(
                `${baseUrl}/v6/swap`,
                {
                    quoteResponse: quoteData,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 'auto',
                },
                config,
            );

            const transaction = VersionedTransaction.deserialize(
                Buffer.from(swapResponse.data.swapTransaction, 'base64'),
            );
            transaction.sign([this.wallet]);

            const txid = await this.connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: true,
                maxRetries: 3,
            });
            await this.connection.confirmTransaction(txid, 'confirmed');

            return { success: true, entryPrice: entryPrice || 1 };
        } catch (error) {
            let message = error.message;
            if (error.response?.data) {
                message = JSON.stringify(error.response.data);
            }
            this.logger.error(`[Jupiter] Swap Error: ${message}`);
            
            if (retryCount < 2) {
                const backoff = 3000 * (retryCount + 1);
                this.logger.log(`[Jupiter] Retrying in ${backoff}ms...`);
                await new Promise((res) => setTimeout(res, backoff));
                return this.executeJupiterSwap(inputMint, outputMint, amount, side, retryCount + 1);
            }
            return { success: false, entryPrice: 0, error: message };
        }
    }
}
