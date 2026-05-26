import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import {
    Connection,
    Keypair,
    VersionedTransaction,
    ParsedTransactionWithMeta,
    TransactionMessage,
    SystemProgram,
    PublicKey,
} from '@solana/web3.js';
import axios from 'axios';
import bs58 from 'bs58';
import * as https from 'https';
import { TokenMetadata } from '../analyzer/analyzer.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportingService } from '../reporting/reporting.service';
import { DexLimiter } from '../common/dex-limiter';

export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

@Injectable()
export class TradeService implements OnModuleInit {
    private readonly logger = new Logger(TradeService.name);
    private connection: Connection;
    private wallet: Keypair;
    private readonly sellingTrades = new Set<number>();
    private jitoTipAccounts: string[] = [];

    private readonly totalCapital: number;
    private readonly reserveAmount: number;
    private readonly totalSlots: number;
    private readonly positionSizeUSD: number;
    private readonly slippageBps: number;
    private readonly jupiterApiKey: string;
    private readonly isDryRun: boolean;
    private readonly httpsAgent: https.Agent;

    // Cache for resolved IPs
    private ipCache: Record<string, string> = {
        'api.jup.ag': '18.239.105.107', // Jupiter Main
        'quote-api.jup.ag': '104.26.11.233', // Jupiter Quote Fallback
        'price.jup.ag': '104.26.10.233', // Jupiter Price API
        '1.1.1.1': '1.1.1.1',
        '8.8.8.8': '8.8.8.8',
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly moduleRef: ModuleRef,
    ) {
        const rpcEndpoint =
            this.configService.get<string>('RPC_ENDPOINT') || 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(rpcEndpoint, 'confirmed');
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
        this.wallet = Keypair.fromSecretKey(
            bs58.decode(this.configService.get<string>('PRIVATE_KEY') || ''),
        );

        // CONFIG BUDGET (Updated by Amirull)
        this.totalCapital = Number.parseFloat(
            this.configService.get<string>('TOTAL_CAPITAL', '20'),
        );
        this.reserveAmount = Number.parseFloat(
            this.configService.get<string>('RESERVE_AMOUNT', '8'),
        ); // $20 - (4 slots * $3) = $8 reserve
        this.totalSlots = Number.parseInt(this.configService.get<string>('TOTAL_SLOTS', '4'), 10);
        this.positionSizeUSD = Number.parseFloat(
            this.configService.get<string>('POSITION_SIZE_USD', '3'),
        );

        this.slippageBps = Number.parseInt(
            this.configService.get<string>('SLIPPAGE_BPS', '100'),
            10,
        );
        this.isDryRun = this.configService.get<string>('DRY_RUN') === 'true';

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

    private get reportingService(): ReportingService {
        return this.moduleRef.get(ReportingService, { strict: false });
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

            // 🚀 JITO TIP ACCOUNTS: Fetch Jito tip accounts on startup
            await this.refreshJitoTipAccounts();

            // 🚀 RESUME MONITORING: Pantau lagi koin yang masih nyangkut/open
            await this.startMonitoringAllTrades();
        }
    }

    private async refreshJitoTipAccounts() {
        const useJito = this.configService.get<string>('USE_JITO') === 'true';
        if (!useJito) return;

        const jitoBlockEngineUrl =
            this.configService.get<string>('JITO_BLOCK_ENGINE_URL') ||
            'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

        try {
            const response = await axios.post(
                jitoBlockEngineUrl,
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getTipAccounts',
                    params: [],
                },
                {
                    headers: { 'Content-Type': 'application/json' },
                    httpsAgent: this.httpsAgent,
                    timeout: 5000,
                },
            );

            if (
                response.data?.result &&
                Array.isArray(response.data.result) &&
                response.data.result.length > 0
            ) {
                this.jitoTipAccounts = response.data.result as string[];
                this.logger.log(
                    `[Jito] Successfully loaded ${this.jitoTipAccounts.length} tip accounts dynamically.`,
                );
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(
                `[Jito] Failed to fetch tip accounts dynamically: ${message}`,
            );
        }
    }

    private async getJitoTipAccount(): Promise<string> {
        if (this.jitoTipAccounts.length === 0) {
            await this.refreshJitoTipAccounts();
        }
        if (this.jitoTipAccounts.length === 0) {
            throw new Error('No Jito tip accounts available from block engine API');
        }
        return this.jitoTipAccounts[Math.floor(Math.random() * this.jitoTipAccounts.length)];
    }

    private async startMonitoringAllTrades() {
        const openTrades = await this.prismaService.trade.count({
            where: { status: 'OPEN' },
        });

        this.logger.log(
            `[Monitor] Found ${openTrades} open positions. PriceMonitorService will handle tracking.`,
        );
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
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.error(`Failed to decode private key: ${msg}`);
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
        customAmountUSD?: number,
        options?: {
            customSlippageBps?: number;
            priorityFeeSol?: number;
            targetTakeProfit?: number;
            targetStopLoss?: number;
            targetTrailingDistance?: number;
        },
    ): Promise<{ success: boolean; message: string }> {
        // 1. Cek apakah sudah punya koin ini (OPEN) atau sedang dalam cooldown
        const recentTrade = await this.prismaService.trade.findFirst({
            where: { tokenMint },
            orderBy: { createdAt: 'desc' },
        });

        if (recentTrade && !customAmountUSD) {
            // Jika manual buy (ada customAmount), abaikan cooldown
            if (recentTrade.status === 'OPEN') {
                return { success: false, message: `Already holding ${tokenMint}` };
            }
            const winCooldownHours = Number.parseInt(
                this.configService.get<string>('COOLDOWN_WIN_HOURS', '6'),
                10,
            );
            const lossCooldownHours = Number.parseInt(
                this.configService.get<string>('COOLDOWN_LOSS_HOURS', '24'),
                10,
            );
            const isWin = (recentTrade.profitUsd || 0) > 0;
            const cooldownHours = isWin ? winCooldownHours : lossCooldownHours;
            const cooldownMillis = cooldownHours * 60 * 60 * 1000;
            const cooldownExpiredAt = recentTrade.updatedAt.getTime() + cooldownMillis;

            if (Date.now() < cooldownExpiredAt) {
                const msg = `Token ${tokenMint} is in cooldown until ${new Date(cooldownExpiredAt).toISOString()} (Last outcome: ${isWin ? 'WIN' : 'LOSS'}, Cooldown: ${cooldownHours}h). Skip.`;
                return { success: false, message: msg };
            }
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
        const priorityFeeLamports = options?.priorityFeeSol
            ? Math.floor(options.priorityFeeSol * 1_000_000_000)
            : undefined;

        // 🛡️ PRE-BUY BALANCE CHECK: Pastikan modal cukup dan tersisa RESERVE_AMOUNT
        const balanceLamports = await this.connection.getBalance(this.wallet.publicKey);
        const balanceSol = balanceLamports / 1_000_000_000;
        const reserveSol = this.reserveAmount / solPrice;
        const totalRequiredSol = amountInSol + reserveSol + 0.005; // 0.005 SOL buffer gas/priority fee

        if (balanceSol < totalRequiredSol) {
            const msg = `Insufficient SOL balance. Have: ${balanceSol.toFixed(4)} SOL, Need: ${totalRequiredSol.toFixed(4)} SOL (Position: ${amountInSol.toFixed(4)} SOL, Reserve: ${reserveSol.toFixed(4)} SOL + Fees). Aborting buy to prevent trapped tokens or wasted fees.`;
            this.logger.warn(`[Slot ${slotToUse}] 🛑 ${msg}`);
            return { success: false, message: msg };
        }

        this.logger.log(
            `[Slot ${slotToUse}] Attempting to buy ${tokenMint} with $${buyAmountUSD} (${amountInSol.toFixed(4)} SOL)`,
        );

        const { success, entryPrice, error, txHash, actualSol, actualTokens } =
            await this.executeJupiterSwap(
                WRAPPED_SOL_MINT,
                tokenMint,
                amountInLamports,
                'BUY',
                buyAmountUSD,
                0,
                options?.customSlippageBps,
                priorityFeeLamports,
            );

        if (success && entryPrice > 0) {
            const finalAmountInSol = actualSol || amountInSol;
            const symbol = await this.fetchTokenSymbol(tokenMint);
            // Get initial balances for watch addresses
            let initialCreatorBalance = 0;
            let initialTopHolderBalance = 0;

            if (metadata?.creator) {
                const bal = await this.getTokenBalance(metadata.creator, tokenMint);
                initialCreatorBalance = typeof bal === 'number' ? bal : 0;
            }
            if (metadata?.topHolder) {
                const bal = await this.getTokenBalance(metadata.topHolder, tokenMint);
                initialTopHolderBalance = typeof bal === 'number' ? bal : 0;
            }

            await this.prismaService.trade.create({
                data: {
                    tokenMint,
                    symbol,
                    slotNumber: slotToUse,
                    entryPrice,
                    highestPrice: entryPrice,
                    trailingStopPrice: 0, // 🛡️ Initialized to 0, PriceMonitor will activate it once in profit
                    status: 'OPEN',
                    amountInSol: finalAmountInSol,
                    buyTxHash: txHash || null,
                    entryLiquidity: metadata?.liquidity || 0,
                    entryMarketCap: metadata?.marketCap || 0,
                    creatorAddress: metadata?.creator,
                    topHolderAddress: metadata?.topHolder,
                    initialCreatorBalance,
                    initialTopHolderBalance,
                    targetTakeProfit: options?.targetTakeProfit,
                    targetStopLoss: options?.targetStopLoss,
                    targetTrailingDistance: options?.targetTrailingDistance,
                },
            });
            this.logger.log(`[Slot ${slotToUse}] Successfully bought ${symbol} (${tokenMint})`);
            const strategyName = options?.targetTakeProfit
                ? '🔥 Established Rebound & CTO (TP 18%, TSL 2.5%, Hard SL 20%)'
                : 'Standard Second-Wave';
            await this.reportingService.sendBuyAlert(
                tokenMint,
                entryPrice,
                slotToUse,
                symbol,
                metadata?.socials,
                strategyName,
                {
                    solSpent: finalAmountInSol,
                    tokensReceived: actualTokens,
                    solPrice,
                },
            );

            // 🚀 MONITORING: PriceMonitorService otomatis akan mendeteksi trade baru dari DB
            return { success: true, message: `Successfully bought ${symbol} at slot ${slotToUse}` };
        }

        return { success: false, message: `Swap failed: ${error || 'Unknown error'}` };
    }

    async executeSell(
        tradeId: number,
        currentPrice: number,
        exitReason: string,
        percentage: number = 1.0,
    ): Promise<boolean> {
        const trade = await this.prismaService.trade.findUnique({ where: { id: tradeId } });
        if (!trade || trade.status !== 'OPEN') {
            this.logger.debug(`[Trade ${tradeId}] Already closed or not found. Skipping sell.`);
            return false;
        }

        // 🛡️ IN-MEMORY LOCK: Prevent double-sell tanpa corrupt DB state
        if (this.sellingTrades.has(tradeId)) {
            this.logger.debug(`[Trade ${tradeId}] Sell already in progress. Skipping.`);
            return false;
        }
        this.sellingTrades.add(tradeId);

        try {
            // 1. DAPETIN SALDO ASLI ATAU SIMULASI
            let actualBalance = 0;
            if (this.isDryRun) {
                const solPrice = await this.getSolPrice();
                actualBalance = (trade.amountInSol * solPrice) / trade.entryPrice;
                this.logger.debug(
                    `[Slot ${trade.slotNumber}] 🤖 DRY RUN: Simulated token balance: ${actualBalance}`,
                );
            } else {
                const fetchedBalance = await this.getTokenBalance(
                    this.wallet.publicKey.toBase58(),
                    trade.tokenMint,
                );
                if (fetchedBalance === null) {
                    this.logger.error(
                        `[Slot ${trade.slotNumber}] ❌ Failed to fetch balance from RPC. Aborting sell to prevent errors.`,
                    );
                    return false;
                }
                actualBalance = fetchedBalance;
            }

            const sellAmount = actualBalance * percentage;
            const decimals = await this.getTokenDecimals(trade.tokenMint);
            const amountInLamports = Math.floor(sellAmount * Math.pow(10, decimals));

            if (amountInLamports <= 0) {
                this.logger.warn(
                    `[Slot ${trade.slotNumber}] ⚠️ Zero balance for ${trade.tokenMint}. Closing trade.`,
                );
                if (percentage >= 1.0) {
                    await this.prismaService.trade.update({
                        where: { id: tradeId },
                        data: { status: 'CLOSED', exitPrice: 0, profitUsd: 0, exitReason },
                    });
                }
                return false;
            }

            this.logger.log(
                `[Slot ${trade.slotNumber}] 💸 Executing SELL (${(percentage * 100).toFixed(0)}%) for ${trade.symbol} (${trade.tokenMint}). Amount: ${sellAmount}`,
            );

            // 2. PANIC SLIPPAGE: Kalau SL, Trailing Stop, atau Rugpull, hajar slippage 15% (1500 bps) biar pasti laku
            const isUrgent = ['STOP_LOSS', 'TRAILING_STOP', 'DEV_DUMP', 'RUGPULL'].includes(
                exitReason,
            );
            const sellSlippage = isUrgent ? 1500 : this.slippageBps;

            // 🚀 Panic Gas Accel: Hajar priority fee tinggi (0.0005 SOL = 500,000 lamports) biar instan masuk block pertama
            const sellPriorityFee = isUrgent ? 500_000 : undefined;

            const {
                success,
                entryPrice: exitPriceResult,
                error,
                txHash,
                actualSol,
                actualTokens,
            } = await this.executeJupiterSwap(
                trade.tokenMint,
                'So11111111111111111111111111111111111111112',
                amountInLamports,
                'SELL',
                undefined,
                0,
                sellSlippage,
                sellPriorityFee,
            );

            if (success) {
                const exitPrice = exitPriceResult || 0;
                const profit = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
                const solPrice = await this.getSolPrice();

                const finalSolReceived = actualSol || (sellAmount * exitPrice) / solPrice;
                const finalTokensSold = actualTokens || sellAmount;
                const entrySolValue = trade.amountInSol * percentage;
                const solProfitPercent = ((finalSolReceived - entrySolValue) / entrySolValue) * 100;

                const entryValueUsd = entrySolValue * solPrice;
                const exitValueUsd = sellAmount * exitPrice;
                const estimatedProfitUsd = exitValueUsd - entryValueUsd;
                const totalUsdSpent = finalTokensSold * trade.entryPrice;
                const totalUsdReceived = finalTokensSold * exitPrice;

                // ✅ DATABASE UPDATE: Hanya dilakukan jika transaksi Solana SUKSES
                if (percentage >= 1.0) {
                    await this.prismaService.trade.update({
                        where: { id: tradeId },
                        data: {
                            status: 'CLOSED',
                            exitPrice,
                            exitReason,
                            sellTxHash: txHash || null,
                            profitUsd: (trade.profitUsd || 0) + estimatedProfitUsd,
                        },
                    });
                } else {
                    await this.prismaService.trade.update({
                        where: { id: tradeId },
                        data: {
                            amountInSol: trade.amountInSol * (1 - percentage),
                            profitUsd: (trade.profitUsd || 0) + estimatedProfitUsd,
                        },
                    });
                }

                // 🧑‍💻 AUTO BLACKLIST ON DEV_DUMP/RUGPULL (Self-Learning)
                if (['DEV_DUMP', 'RUGPULL'].includes(exitReason) && trade.creatorAddress) {
                    try {
                        const existingProfile = await this.prismaService.creatorProfile.findUnique({
                            where: { address: trade.creatorAddress },
                        });
                        const ruggedCount = (existingProfile?.ruggedTokens || 0) + 1;
                        const createdCount = existingProfile?.tokensCreated || 1;
                        const tags = new Set(existingProfile?.tags || []);
                        tags.add('Serial Rugger');

                        await this.prismaService.creatorProfile.upsert({
                            where: { address: trade.creatorAddress },
                            update: {
                                reason: exitReason,
                                ruggedTokens: ruggedCount,
                                isBlacklisted: true,
                                riskScore: 100, // Instant blacklist
                                tags: Array.from(tags),
                                lastActiveAt: new Date(),
                            },
                            create: {
                                address: trade.creatorAddress,
                                reason: exitReason,
                                tokensCreated: createdCount,
                                ruggedTokens: 1,
                                isBlacklisted: true,
                                riskScore: 100,
                                tags: ['Serial Rugger'],
                            },
                        });
                        this.logger.warn(
                            `[Blacklist] Automatically blacklisted creator ${trade.creatorAddress} for: ${exitReason}`,
                        );
                    } catch (dbErr) {
                        const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
                        this.logger.error(
                            `[Blacklist] Failed to blacklist creator ${trade.creatorAddress}: ${msg}`,
                        );
                    }
                }

                await this.reportingService.sendSellAlert(
                    trade.tokenMint,
                    exitPrice,
                    profit,
                    exitReason,
                    trade.symbol || undefined,
                    {
                        entryPriceUsd: trade.entryPrice,
                        exitPriceUsd: exitPrice,
                        entryPriceSol: entrySolValue / finalTokensSold,
                        exitPriceSol: finalSolReceived / finalTokensSold,
                        solSpent: entrySolValue,
                        solReceived: finalSolReceived,
                        solProfitPercent,
                        usdSpent: totalUsdSpent,
                        usdReceived: totalUsdReceived,
                    },
                );
                return true;
            }

            // ❌ SELL FAILED — trade tetap OPEN (tidak pernah di-CLOSED sebelum swap)
            this.logger.error(
                `[Slot ${trade.slotNumber}] ❌ SELL FAILED on Solana: ${error}. Trade remains OPEN for retry.`,
            );
            return false;
        } catch (error) {
            this.logger.error(
                `[Slot ${trade.slotNumber}] ❌ SELL CRITICAL ERROR: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
        } finally {
            this.sellingTrades.delete(tradeId);
        }
    }

    private async executeJupiterSwap(
        inputMint: string,
        outputMint: string,
        amount: number,
        side: 'BUY' | 'SELL',
        buyAmountUSD?: number,
        retryCount = 0,
        customSlippageBps?: number,
        priorityFeeLamports?: number,
    ): Promise<{
        success: boolean;
        entryPrice: number;
        error?: string;
        txHash?: string;
        actualSol?: number;
        actualTokens?: number;
    }> {
        const maxRetries = Number.parseInt(
            this.configService.get<string>('TRADE_MAX_RETRIES', '5'),
            10,
        );
        try {
            // Jurus Pamungkas: Pakai Paid Endpoint & API Key
            const hostname = 'api.jup.ag';
            const baseUrl = `https://${hostname}`;

            this.logger.log(
                `[Jupiter] Fetching quote for ${side} (Attempt ${retryCount + 1}/${maxRetries})...`,
            );

            const timeout = Number.parseInt(
                this.configService.get<string>('TRADE_TIMEOUT_MS', '20000'),
                10,
            );
            const config = {
                timeout,
                headers: {
                    'Accept-Encoding': 'gzip, deflate, br',
                    'x-api-key': this.jupiterApiKey,
                },
                httpsAgent: this.httpsAgent,
            };

            // 🛠 DYNAMIC SLIPPAGE: Naikin slippage tiap kali gagal
            let slippage = customSlippageBps || this.slippageBps;
            if (retryCount > 0) {
                slippage = Math.min(slippage + retryCount * 250, 2000); // Tambah 2.5% tiap retry, max 20%
                this.logger.warn(`[Jupiter] Retrying with higher slippage: ${slippage} bps`);
            }

            const quoteUrl = `${baseUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}`;
            const quoteResponse = await axios.get(quoteUrl, config);
            const quoteData = quoteResponse.data;

            // 🛡️ PRICE IMPACT GUARD
            if (side === 'BUY' && quoteData.priceImpactPct) {
                const priceImpact = parseFloat(quoteData.priceImpactPct);
                const maxPriceImpact = parseFloat(
                    this.configService.get<string>('MAX_PRICE_IMPACT_PCT', '15.0'),
                );
                if (priceImpact > maxPriceImpact) {
                    this.logger.warn(
                        `[Jupiter] 🛑 BUY rejected due to high price impact: ${priceImpact}% (Max allowed: ${maxPriceImpact}%)`,
                    );
                    return {
                        success: false,
                        entryPrice: 0,
                        error: `high_price_impact: ${priceImpact}%`,
                    };
                }
            }

            let price = 0;
            const decimals = await this.getTokenDecimals(side === 'BUY' ? outputMint : inputMint);
            if (side === 'BUY') {
                const usdValue = buyAmountUSD || this.positionSizeUSD;
                price = usdValue / (quoteData.outAmount / Math.pow(10, decimals));
            } else {
                // SELL: Price = (outAmount_sol * solPrice) / inAmount_token
                const solPrice = await this.getSolPrice();
                const outAmountSol = quoteData.outAmount / 1_000_000_000;
                const inAmountToken = amount / Math.pow(10, decimals);
                price = (outAmountSol * solPrice) / inAmountToken;

                // 🛡️ SANITY CHECK: Sell price tidak mungkin > $1 untuk microcap token
                // Jika price > $1 atau <= 0, kemungkinan besar decimals error
                if (price > 1 || price <= 0) {
                    this.logger.error(
                        `[Jupiter] ⚠️ INSANE SELL PRICE: $${price.toFixed(8)} for ${inputMint}. Likely decimals error (got ${decimals}). Falling back to Jupiter Price API.`,
                    );
                    const fallbackPrice = await this.getSellPriceFallback(inputMint);
                    if (fallbackPrice && fallbackPrice > 0 && fallbackPrice < 1) {
                        price = fallbackPrice;
                        this.logger.log(`[Jupiter] ✅ Fallback price: $${price.toFixed(8)}`);
                    } else {
                        this.logger.error(
                            `[Jupiter] ❌ Fallback price also failed. Using raw calculated price.`,
                        );
                    }
                }
            }

            // 🤖 DRY RUN MODE: Skip actual swap execution, just return simulated success with quote price
            if (this.isDryRun) {
                this.logger.log(
                    `[DRY RUN] 🤖 Simulated ${side} Quote obtained: $${price.toFixed(8)}. Skipping real transaction.`,
                );
                return {
                    success: true,
                    entryPrice: price || 0.00000001,
                    txHash: `simulated_tx_${Date.now()}`,
                };
            }

            // ⛽ DYNAMIC FEES: Naikin gas tiap kali gagal (Auto-Multiplier + Retry Bonus)
            const useJito = this.configService.get<string>('USE_JITO') === 'true';
            const jitoBlockEngineUrl =
                this.configService.get<string>('JITO_BLOCK_ENGINE_URL') ||
                'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
            const jitoTipSol = Number.parseFloat(
                this.configService.get<string>('JITO_TIP_SOL') || '0.0001',
            );

            const baseMultiplier = Number.parseInt(
                this.configService.get<string>('TRADE_PRIORITY_MULTIPLIER', '2'),
                10,
            );
            const multiplier = baseMultiplier + retryCount * 2;
            let feeConfig: number | { autoMultiplier: number } =
                priorityFeeLamports && priorityFeeLamports > 0
                    ? priorityFeeLamports
                    : { autoMultiplier: multiplier };

            if (useJito) {
                feeConfig = 0; // Jito relies on bundle tip, not priority fee
                this.logger.debug(`[Jupiter] 🚀 Using Jito MEV. Jupiter priority fee set to 0.`);
            }

            const swapResponse = await axios.post(
                `${baseUrl}/swap/v1/swap`,
                {
                    quoteResponse: quoteData,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: feeConfig,
                },
                config,
            );

            const transaction = VersionedTransaction.deserialize(
                Buffer.from(swapResponse.data.swapTransaction, 'base64'),
            );
            transaction.sign([this.wallet]);

            let txid = '';

            if (useJito) {
                const randomTipAccount = await this.getJitoTipAccount();
                const tipLamports = Math.floor(jitoTipSol * 1_000_000_000);

                const tx2Message = new TransactionMessage({
                    payerKey: this.wallet.publicKey,
                    recentBlockhash: transaction.message.recentBlockhash,
                    instructions: [
                        SystemProgram.transfer({
                            fromPubkey: this.wallet.publicKey,
                            toPubkey: new PublicKey(randomTipAccount),
                            lamports: tipLamports,
                        }),
                    ],
                }).compileToV0Message();

                const tx2 = new VersionedTransaction(tx2Message);
                tx2.sign([this.wallet]);

                const tx1Base58 = bs58.encode(transaction.serialize());
                const tx2Base58 = bs58.encode(tx2.serialize());

                this.logger.log(
                    `[Jito] 🚀 Sending Bundle (Tip: ${jitoTipSol} SOL to ${randomTipAccount})...`,
                );

                try {
                    const bundleResponse = await axios.post(
                        jitoBlockEngineUrl,
                        {
                            jsonrpc: '2.0',
                            id: 1,
                            method: 'sendBundle',
                            params: [[tx2Base58, tx1Base58]],
                        },
                        { headers: { 'Content-Type': 'application/json' } },
                    );

                    if (bundleResponse.data?.error) {
                        throw new Error(
                            `Jito Bundle Error: ${JSON.stringify(bundleResponse.data.error)}`,
                        );
                    }

                    this.logger.log(
                        `[Jito] 🎉 Bundle accepted! ID: ${bundleResponse.data?.result}`,
                    );
                    txid = bs58.encode(transaction.signatures[0]);
                } catch (e: unknown) {
                    const errResponse =
                        e instanceof Error && 'response' in e
                            ? JSON.stringify(
                                  (e as { response?: { data?: unknown } }).response?.data,
                              )
                            : '';
                    const msg = e instanceof Error ? e.message : String(e);
                    this.logger.error(`[Jito] Bundle submission failed: ${msg} ${errResponse}`);
                    throw new Error(`Jito Submission Error: ${msg}`);
                }
            } else {
                txid = await this.connection.sendRawTransaction(transaction.serialize(), {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: 3,
                });
            }

            this.logger.log(`[Jupiter] Transaction sent: ${txid}. Waiting confirmation...`);

            const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
            const confirmation = await this.connection.confirmTransaction(
                {
                    signature: txid,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                },
                'confirmed',
            );

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            // 🛡️ AMBIL HARGA EKSEKUSI RIIL DARI BLOCKCHAIN
            let finalPrice = price;
            let actualSol =
                side === 'BUY' ? amount / 1_000_000_000 : quoteData.outAmount / 1_000_000_000;
            let actualTokens =
                side === 'BUY'
                    ? quoteData.outAmount / Math.pow(10, decimals)
                    : amount / Math.pow(10, decimals);

            try {
                const actualSwap = await this.getActualSwapDetails(
                    txid,
                    this.wallet.publicKey.toBase58(),
                    side === 'BUY' ? outputMint : inputMint,
                );
                if (actualSwap) {
                    const solPrice = await this.getSolPrice();
                    actualSol = Math.abs(actualSwap.solChange);
                    actualTokens = Math.abs(actualSwap.tokenChange);
                    if (side === 'BUY') {
                        if (actualTokens > 0) {
                            finalPrice = (actualSol * solPrice) / actualTokens;
                            this.logger.log(
                                `[Jupiter] Actual BUY price calculated from on-chain balances: $${finalPrice.toFixed(8)} (Quote: $${price.toFixed(8)})`,
                            );
                        }
                    } else {
                        if (actualTokens > 0) {
                            finalPrice = (actualSol * solPrice) / actualTokens;
                            this.logger.log(
                                `[Jupiter] Actual SELL price calculated from on-chain balances: $${finalPrice.toFixed(8)} (Quote: $${price.toFixed(8)})`,
                            );
                        }
                    }
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.error(
                    `[Jupiter] Failed to fetch actual swap details: ${msg}. Falling back to quote price.`,
                );
            }

            return {
                success: true,
                entryPrice: finalPrice || 0.00000001,
                txHash: txid,
                actualSol,
                actualTokens,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (retryCount < maxRetries - 1) {
                const waitTime = 1000 * (retryCount + 1);
                this.logger.log(`[Jupiter] Retrying in ${waitTime}ms...`);
                await new Promise((res) => setTimeout(res, waitTime));
                return this.executeJupiterSwap(
                    inputMint,
                    outputMint,
                    amount,
                    side,
                    buyAmountUSD,
                    retryCount + 1,
                    customSlippageBps,
                    priorityFeeLamports,
                );
            }
            return { success: false, entryPrice: 0, error: message, txHash: undefined };
        }
    }

    private async getActualSwapDetails(
        txHash: string,
        wallet: string,
        tokenMint: string,
    ): Promise<{ solChange: number; tokenChange: number } | null> {
        let tx: ParsedTransactionWithMeta | null = null;
        for (let i = 0; i < 5; i++) {
            try {
                tx = await this.connection.getParsedTransaction(txHash, {
                    maxSupportedTransactionVersion: 0,
                });
                if (tx) break;
            } catch (err) {
                this.logger.warn(
                    `Failed to parse transaction ${txHash} on attempt ${i + 1}: ${err}`,
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        if (!tx) return null;

        // Cari perubahan saldo SOL wallet
        const walletIndex = tx.transaction.message.accountKeys.findIndex(
            (k) => k.pubkey.toBase58() === wallet,
        );
        let solChange = 0;
        if (walletIndex !== -1) {
            const preSol = tx.meta?.preBalances[walletIndex] ?? 0;
            const postSol = tx.meta?.postBalances[walletIndex] ?? 0;
            solChange = (postSol - preSol) / 1_000_000_000;
        }

        // Cari perubahan saldo Token wallet
        const preTokenAmount =
            tx.meta?.preTokenBalances?.find((b) => b.owner === wallet && b.mint === tokenMint)
                ?.uiTokenAmount.uiAmount ?? 0;
        const postTokenAmount =
            tx.meta?.postTokenBalances?.find((b) => b.owner === wallet && b.mint === tokenMint)
                ?.uiTokenAmount.uiAmount ?? 0;
        const tokenChange = postTokenAmount - preTokenAmount;

        return { solChange, tokenChange };
    }

    private async fetchTokenSymbol(tokenMint: string): Promise<string> {
        try {
            // Try DexScreener first
            const response = await DexLimiter.get<{
                pairs: Array<{ baseToken?: { symbol?: string } }>;
            }>(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
                timeout: 3000,
                httpsAgent: this.httpsAgent,
            });
            const dexSymbol = response.data?.pairs?.[0]?.baseToken?.symbol;
            if (dexSymbol) return `$${dexSymbol}`;

            return 'UNKNOWN';
        } catch {
            return 'UNKNOWN';
        }
    }

    async getTokenDecimals(tokenMint: string): Promise<number> {
        // 💊 PUMP.FUN DETECTOR: Koin pump.fun selalu 6 desimal
        if (tokenMint.toLowerCase().endsWith('pump')) {
            return 6;
        }

        try {
            const { PublicKey } = await import('@solana/web3.js');
            const { getMint } = await import('@solana/spl-token');
            const mintPublicKey = new PublicKey(tokenMint);
            const accountInfo = await this.connection.getAccountInfo(mintPublicKey);
            const programId = accountInfo ? accountInfo.owner : undefined;
            const mintInfo = await getMint(this.connection, mintPublicKey, undefined, programId);
            return mintInfo.decimals;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(
                `Failed to fetch decimals for ${tokenMint}: ${msg}. Defaulting to 6 (microcap standard).`,
            );
            return 6; // Majority of microcap Solana tokens use 6 decimals
        }
    }

    /**
     * Fallback price fetcher using Jupiter Price API.
     * Used when sell price calculation produces impossible values.
     */
    private async getSellPriceFallback(tokenMint: string): Promise<number | null> {
        try {
            const response = await axios.get(`https://api.jup.ag/price/v3?ids=${tokenMint}`, {
                timeout: 5000,
                headers: { 'x-api-key': this.jupiterApiKey },
                httpsAgent: this.httpsAgent,
            });
            const data = response.data as Record<string, { usdPrice?: number } | undefined> | null;
            const price = data?.[tokenMint]?.usdPrice;
            return price && !isNaN(price) ? price : null;
        } catch {
            return null;
        }
    }

    async getTokenBalance(walletAddress: string, tokenMint: string): Promise<number | null> {
        try {
            const accounts = await this.connection.getParsedTokenAccountsByOwner(
                new (await import('@solana/web3.js')).PublicKey(walletAddress),
                { mint: new (await import('@solana/web3.js')).PublicKey(tokenMint) },
            );

            if (accounts.value.length > 0) {
                return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
            }
            return 0;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to get token balance for ${walletAddress}: ${msg}`);
            return null; // Return null biar bot tahu ini error API, bukan saldo 0
        }
    }

    async getSolPrice(): Promise<number> {
        try {
            const response = await axios.get(
                `https://api.jup.ag/price/v3?ids=${WRAPPED_SOL_MINT}`,
                {
                    timeout: 3000,
                    headers: { 'x-api-key': this.jupiterApiKey },
                    httpsAgent: this.httpsAgent,
                },
            );
            const data = response.data as Record<string, { usdPrice?: number } | undefined> | null;
            return data?.[WRAPPED_SOL_MINT]?.usdPrice || 150;
        } catch {
            return 150; // Fallback jika API Jupiter down
        }
    }

    /**
     * Manual Trade Handlers for Telegram
     */
    async handleManualBuy(
        tokenMint: string,
        amountUSD: number,
    ): Promise<{ success: boolean; message: string }> {
        this.logger.log(`[Manual Buy] Initiating buy for ${tokenMint} with $${amountUSD}`);
        return this.attemptBuy(tokenMint, undefined, amountUSD);
    }

    async handleManualSell(
        tokenMint: string,
        percentage: number,
    ): Promise<{ success: boolean; message: string }> {
        const trade = await this.prismaService.trade.findFirst({
            where: { tokenMint, status: 'OPEN' },
        });

        const currentPrice = await this.reportingService.fetchCurrentPrice(tokenMint);
        if (!currentPrice) {
            return { success: false, message: 'Failed to fetch current price.' };
        }

        if (trade) {
            await this.executeSell(trade.id, currentPrice, 'MANUAL_SELL', percentage);
            return {
                success: true,
                message: `Sell order for ${(percentage * 100).toFixed(0)}% executed.`,
            };
        } else {
            // Manual sell for token not in DB
            const actualBalance = await this.getTokenBalance(
                this.wallet.publicKey.toBase58(),
                tokenMint,
            );
            if (actualBalance === null || actualBalance <= 0)
                return { success: false, message: 'Zero or invalid balance in wallet.' };

            const decimals = await this.getTokenDecimals(tokenMint);
            const amountInLamports = Math.floor(
                actualBalance * percentage * Math.pow(10, decimals),
            );

            const { success, error } = await this.executeJupiterSwap(
                tokenMint,
                WRAPPED_SOL_MINT,
                amountInLamports,
                'SELL',
            );

            if (success) {
                return {
                    success: true,
                    message: `Manual sell for ${(percentage * 100).toFixed(0)}% (${tokenMint}) executed.`,
                };
            }
            return { success: false, message: error || 'Swap failed' };
        }
    }

    async getWalletHoldings(): Promise<Array<{ mint: string; symbol: string; balance: number }>> {
        try {
            const { PublicKey } = await import('@solana/web3.js');
            const accounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
            );

            const holdings: Array<{ mint: string; symbol: string; balance: number }> = [];

            for (const account of accounts.value) {
                const mint = account.account.data.parsed.info.mint;
                const balance = account.account.data.parsed.info.tokenAmount.uiAmount;

                if (balance > 0) {
                    // Try to find symbol from DB first
                    const trade = await this.prismaService.trade.findFirst({
                        where: { tokenMint: mint },
                    });
                    const symbol = trade?.symbol || (await this.fetchTokenSymbol(mint));

                    // Filter out dust (very small values)
                    const dustThreshold = Number.parseFloat(
                        this.configService.get<string>('TRADE_DUST_THRESHOLD', '0.000001'),
                    );
                    if (balance > dustThreshold) {
                        holdings.push({ mint, symbol, balance });
                    }
                }
            }

            return holdings;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to fetch wallet holdings: ${msg}`);
            return [];
        }
    }
}
