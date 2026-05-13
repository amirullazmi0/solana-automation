import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PrismaService } from '../prisma/prisma.service';
import { ReportingService } from '../reporting/reporting.service';
import { TokenMetadata } from '../analyzer/analyzer.service';
import axios from 'axios';
import * as https from 'https';
import { lookup } from 'dns';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

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
    private readonly jupiterApiKey: string;

    // Cache for resolved IPs
    private ipCache: Record<string, string> = {
        'api.jup.ag': '18.239.105.107',       // Jupiter Main
        'quote-api.jup.ag': '104.26.11.233',   // Jupiter Quote Fallback
        'price.jup.ag': '104.26.10.233',       // Jupiter Price API
        '1.1.1.1': '1.1.1.1',
        '8.8.8.8': '8.8.8.8',
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly reportingService: ReportingService,
    ) {
        const rpcEndpoint = this.configService.get<string>('RPC_ENDPOINT') || 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(rpcEndpoint, 'confirmed');
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
        this.wallet = Keypair.fromSecretKey(bs58.decode(this.configService.get<string>('PRIVATE_KEY') || ''));

        // CONFIG BUDGET (Updated by Amirull)
        this.totalCapital = Number.parseFloat(this.configService.get<string>('TOTAL_CAPITAL', '20'));
        this.reserveAmount = Number.parseFloat(this.configService.get<string>('RESERVE_AMOUNT', '8')); // $20 - (4 slots * $3) = $8 reserve
        this.totalSlots = Number.parseInt(this.configService.get<string>('TOTAL_SLOTS', '4'), 10);
        this.positionSizeUSD = Number.parseFloat(this.configService.get<string>('POSITION_SIZE_USD', '3'));

        this.slippageBps = Number.parseInt(this.configService.get<string>('SLIPPAGE_BPS', '100'), 10);
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

    async attemptBuy(
        tokenMint: string, 
        metadata?: TokenMetadata, 
        customAmountUSD?: number
    ): Promise<{ success: boolean; message: string }> {
        // 1. Cek apakah sudah punya koin ini (OPEN) atau sudah pernah trading dalam 24 jam terakhir (Cooldown)
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const existing = await this.prismaService.trade.findFirst({
            where: { 
                tokenMint, 
                createdAt: { gte: dayAgo }
            }
        });

        if (existing && !customAmountUSD) { // Jika manual buy (ada customAmount), abaikan cooldown
            const msg = existing.status === 'OPEN' ? `Already holding ${tokenMint}` : `Token ${tokenMint} is in 24h cooldown. Skip.`;
            return { success: false, message: msg };
        }

        const openTradesCount = await this.prismaService.trade.count({ where: { status: 'OPEN' } });
        if (openTradesCount >= this.totalSlots && !customAmountUSD) {
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

        // Use custom amount if provided, otherwise use config
        const buyAmountUSD = customAmountUSD || this.positionSizeUSD;
        
        // Ambil harga SOL terbaru
        const solPrice = await this.getSolPrice();
        const amountInSol = buyAmountUSD / solPrice; 
        const amountInLamports = Math.floor(amountInSol * 1_000_000_000);

        this.logger.log(`[Slot ${slotToUse}] Attempting to buy ${tokenMint} with $${buyAmountUSD} (${amountInSol.toFixed(4)} SOL)`);

        const { success, entryPrice, error } = await this.executeJupiterSwap(
            WRAPPED_SOL_MINT,
            tokenMint,
            amountInLamports,
            'BUY',
            buyAmountUSD,
        );

        if (success && entryPrice > 0) {
            const symbol = await this.fetchTokenSymbol(tokenMint);
            // Get initial balances for watch addresses
            let initialCreatorBalance = 0;
            let initialTopHolderBalance = 0;

            if (metadata?.creator) {
                initialCreatorBalance = await this.getTokenBalance(metadata.creator, tokenMint);
            }
            if (metadata?.topHolder) {
                initialTopHolderBalance = await this.getTokenBalance(metadata.topHolder, tokenMint);
            }

            await this.prismaService.trade.create({
                data: {
                    tokenMint,
                    symbol,
                    slotNumber: slotToUse,
                    entryPrice,
                    highestPrice: entryPrice,
                    trailingStopPrice: entryPrice * 0.9,
                    status: 'OPEN',
                    amountInSol,
                    entryLiquidity: metadata?.liquidity || 0,
                    entryMarketCap: metadata?.marketCap || 0,
                    creatorAddress: metadata?.creator,
                    topHolderAddress: metadata?.topHolder,
                    initialCreatorBalance,
                    initialTopHolderBalance,
                },
            });
            this.logger.log(`[Slot ${slotToUse}] Successfully bought ${symbol} (${tokenMint})`);
            await this.reportingService.sendBuyAlert(tokenMint, entryPrice, slotToUse, symbol, metadata?.socials);
            return { success: true, message: `Successfully bought ${symbol} at slot ${slotToUse}` };
        }

        return { success: false, message: `Swap failed: ${error || 'Unknown error'}` };
    }

    async executeSell(
        tradeId: number, 
        currentPrice: number, 
        isStopLoss: boolean,
        percentage: number = 1.0
    ) {
        const trade = await this.prismaService.trade.findUnique({ where: { id: tradeId } });
        if (!trade || trade.status !== 'OPEN') {
            this.logger.debug(`[Trade ${tradeId}] Already closed or not found. Skipping sell.`);
            return;
        }

        try {
            // 1. ATOMIC LOCK (Hanya jika full sell)
            if (percentage >= 1.0) {
                await this.prismaService.trade.update({
                    where: { id: tradeId },
                    data: { status: 'CLOSED' }
                });
            }

            // 2. DAPETIN SALDO ASLI
            const actualBalance = await this.getTokenBalance(this.wallet.publicKey.toBase58(), trade.tokenMint);
            const sellAmount = actualBalance * percentage;
            const decimals = await this.getTokenDecimals(trade.tokenMint);
            const amountInLamports = Math.floor(sellAmount * Math.pow(10, decimals));

            if (amountInLamports <= 0) {
                this.logger.warn(`[Slot ${trade.slotNumber}] ⚠️ Zero balance for ${trade.tokenMint}. Closing trade.`);
                if (percentage >= 1.0) {
                    await this.prismaService.trade.update({
                        where: { id: tradeId },
                        data: { exitPrice: 0, profitUsd: 0 }
                    });
                }
                return;
            }

            this.logger.log(`[Slot ${trade.slotNumber}] 💸 Executing SELL (${(percentage * 100).toFixed(0)}%) for ${trade.symbol} (${trade.tokenMint}). Amount: ${sellAmount}`);
            
            const { success, error } = await this.executeJupiterSwap(
                trade.tokenMint,
                WRAPPED_SOL_MINT,
                amountInLamports,
                'SELL',
            );

            if (success) {
                const profit = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
                const solPrice = await this.getSolPrice();
                const estimatedProfitUsd = (sellAmount * currentPrice) - ((trade.amountInSol * percentage) * solPrice);

                if (percentage >= 1.0) {
                    await this.prismaService.trade.update({
                        where: { id: tradeId },
                        data: { 
                            exitPrice: currentPrice,
                            profitUsd: (trade.profitUsd || 0) + estimatedProfitUsd
                        },
                    });
                } else {
                    // Update trade record for partial sell
                    await this.prismaService.trade.update({
                        where: { id: tradeId },
                        data: {
                            amountInSol: trade.amountInSol * (1 - percentage),
                            profitUsd: (trade.profitUsd || 0) + estimatedProfitUsd
                        }
                    });
                }
                
                await this.reportingService.sendSellAlert(
                    trade.tokenMint,
                    currentPrice,
                    profit,
                    isStopLoss,
                    trade.symbol || undefined,
                );
                this.logger.log(`[Slot ${trade.slotNumber}] ✅ Position ${percentage >= 1.0 ? 'CLOSED' : 'PARTIALLY SOLD'}. Profit: ${profit.toFixed(2)}%`);
            } else {
                throw new Error(error || 'Swap failed');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[Slot ${trade.slotNumber}] ❌ SELL FAILED: ${message}. Rolling back.`);
            
            if (percentage >= 1.0) {
                await this.prismaService.trade.update({
                    where: { id: tradeId },
                    data: { status: 'OPEN' }
                });
            }
        }
    }

    private async executeJupiterSwap(
        inputMint: string,
        outputMint: string,
        amount: number,
        side: 'BUY' | 'SELL',
        buyAmountUSD?: number,
        retryCount = 0,
    ): Promise<{ success: boolean; entryPrice: number; error?: string }> {
        try {
            if (retryCount === 0) await new Promise((res) => setTimeout(res, Math.random() * 2000));

            // Jurus Pamungkas: Pakai Paid Endpoint & API Key
            const hostname = 'api.jup.ag';
            const baseUrl = `https://${hostname}`;

            this.logger.log(`[Jupiter] Fetching quote for ${side} (Attempt ${retryCount + 1})...`);

            const timeout = Number.parseInt(this.configService.get<string>('TRADE_TIMEOUT_MS', '20000'), 10);
            const config = {
                timeout,
                headers: { 
                    'Accept-Encoding': 'gzip, deflate, br',
                    'x-api-key': this.jupiterApiKey
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

            const quoteUrl = `${baseUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${this.slippageBps}`;
            const quoteResponse = await axios.get(quoteUrl, config);
            const quoteData = quoteResponse.data;

            let entryPrice = 0;
            if (side === 'BUY') {
                const decimals = await this.getTokenDecimals(outputMint);
                const usdValue = buyAmountUSD || this.positionSizeUSD;
                entryPrice = usdValue / (quoteData.outAmount / Math.pow(10, decimals));
            }

            const swapResponse = await axios.post(
                `${baseUrl}/swap/v1/swap`,
                {
                    quoteResponse: quoteData,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    // "Pecah Telur" Mode: Bayar lebih mahal biar nyalip antrean
                    prioritizationFeeLamports: {
                        autoMultiplier: Number.parseInt(this.configService.get<string>('TRADE_PRIORITY_MULTIPLIER', '2'), 10)
                    },
                },
                config,
            );

            const transaction = VersionedTransaction.deserialize(
                Buffer.from(swapResponse.data.swapTransaction, 'base64'),
            );
            transaction.sign([this.wallet]);

            const txid = await this.connection.sendRawTransaction(transaction.serialize(), {
                skipPreflight: true,
                maxRetries: Number.parseInt(this.configService.get<string>('TRADE_MAX_RETRIES', '5'), 10), 
            });
            
            this.logger.log(`[Jupiter] Transaction sent: ${txid}. Waiting for confirmation...`);
            
            // Konfirmasi lebih agresif
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({
                signature: txid,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, 'confirmed');

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
    private async fetchTokenSymbol(tokenMint: string): Promise<string> {
        try {
            // Try DexScreener first
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
                timeout: 3000,
            });
            const dexSymbol = response.data?.pairs?.[0]?.baseToken?.symbol;
            if (dexSymbol) return `$${dexSymbol}`;

            return 'UNKNOWN';
        } catch {
            return 'UNKNOWN';
        }
    }

    async getTokenDecimals(tokenMint: string): Promise<number> {
        try {
            const mintPublicKey = new (await import('@solana/web3.js')).PublicKey(tokenMint);
            const mintInfo = await (await import('@solana/spl-token')).getMint(this.connection, mintPublicKey);
            return mintInfo.decimals;
        } catch (error) {
            this.logger.error(`Failed to fetch decimals for ${tokenMint}: ${error.message}. Defaulting to 9.`);
            return 9; // Fallback ke 9 desimal (standar SPL)
        }
    }

    async getTokenBalance(walletAddress: string, tokenMint: string): Promise<number> {
        try {
            const accounts = await this.connection.getParsedTokenAccountsByOwner(
                new (await import('@solana/web3.js')).PublicKey(walletAddress),
                { mint: new (await import('@solana/web3.js')).PublicKey(tokenMint) }
            );

            if (accounts.value.length > 0) {
                return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
            }
            return 0;
        } catch (error) {
            this.logger.error(`Failed to get token balance for ${walletAddress}: ${error.message}`);
            return 0;
        }
    }

    async getSolPrice(): Promise<number> {
        try {
            const response = await axios.get(`https://api.jup.ag/price/v2?ids=${WRAPPED_SOL_MINT}`, {
                timeout: 3000,
                headers: { 'x-api-key': this.jupiterApiKey }
            });
            return parseFloat(response.data?.data?.[WRAPPED_SOL_MINT]?.price) || 150;
        } catch {
            return 150; // Fallback jika API Jupiter down
        }
    }

    /**
     * Manual Trade Handlers for Telegram
     */
    async handleManualBuy(tokenMint: string, amountUSD: number): Promise<{ success: boolean; message: string }> {
        this.logger.log(`[Manual Buy] Initiating buy for ${tokenMint} with $${amountUSD}`);
        return this.attemptBuy(tokenMint, undefined, amountUSD);
    }

    async handleManualSell(tokenMint: string, percentage: number): Promise<{ success: boolean; message: string }> {
        const trade = await this.prismaService.trade.findFirst({
            where: { tokenMint, status: 'OPEN' }
        });

        const currentPrice = await this.reportingService.fetchCurrentPrice(tokenMint);
        if (!currentPrice) {
            return { success: false, message: 'Failed to fetch current price.' };
        }

        if (trade) {
            await this.executeSell(trade.id, currentPrice, false, percentage);
            return { success: true, message: `Sell order for ${(percentage * 100).toFixed(0)}% executed.` };
        } else {
            // Manual sell for token not in DB
            const actualBalance = await this.getTokenBalance(this.wallet.publicKey.toBase58(), tokenMint);
            if (actualBalance <= 0) return { success: false, message: 'Zero balance in wallet.' };

            const decimals = await this.getTokenDecimals(tokenMint);
            const amountInLamports = Math.floor(actualBalance * percentage * Math.pow(10, decimals));

            const { success, error } = await this.executeJupiterSwap(
                tokenMint,
                WRAPPED_SOL_MINT,
                amountInLamports,
                'SELL',
            );

            if (success) {
                return { success: true, message: `Manual sell for ${(percentage * 100).toFixed(0)}% (${tokenMint}) executed.` };
            }
            return { success: false, message: error || 'Swap failed' };
        }
    }

    async getWalletHoldings(): Promise<Array<{ mint: string; symbol: string; balance: number }>> {
        try {
            const { PublicKey } = await import('@solana/web3.js');
            const accounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
            );

            const holdings: Array<{ mint: string; symbol: string; balance: number }> = [];

            for (const account of accounts.value) {
                const mint = account.account.data.parsed.info.mint;
                const balance = account.account.data.parsed.info.tokenAmount.uiAmount;

                if (balance > 0) {
                    // Try to find symbol from DB first
                    const trade = await this.prismaService.trade.findFirst({ where: { tokenMint: mint } });
                    const symbol = trade?.symbol || await this.fetchTokenSymbol(mint);
                    
                    // Filter out dust (very small values)
                    const dustThreshold = Number.parseFloat(this.configService.get<string>('TRADE_DUST_THRESHOLD', '0.000001'));
                    if (balance > dustThreshold) {
                        holdings.push({ mint, symbol, balance });
                    }
                }
            }

            return holdings;
        } catch (error) {
            this.logger.error(`Failed to fetch wallet holdings: ${error.message}`);
            return [];
        }
    }
}
