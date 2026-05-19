import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import axios from 'axios';
import * as https from 'https';
import { DexScreenerPair, TokenMetadata } from './analyzer.service';
import { TradeService } from '../trade/trade.service';
import { ModuleRef } from '@nestjs/core';

interface RugCheckMarket {
    lpType: string;
    lpStatus: string;
}

@Injectable()
export class EstablishedAnalyzerService {
    private readonly logger = new Logger(EstablishedAnalyzerService.name);
    private readonly connection: Connection;
    private readonly ipCache: Record<string, string> = {
        'api.rugcheck.xyz': '104.26.0.126',
        'api.dexscreener.com': '104.26.8.188',
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly moduleRef: ModuleRef,
    ) {
        const rpcEndpoint = this.configService.get<string>('RPC_ENDPOINT') || 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(rpcEndpoint, 'confirmed');
    }

    private get tradeService(): TradeService {
        return this.moduleRef.get(TradeService, { strict: false });
    }

    private getHttpsAgent() {
        return new https.Agent({
            family: 4,
            keepAlive: true,
        });
    }

    private async resolveDns(hostname: string): Promise<string> {
        if (this.ipCache[hostname]) return this.ipCache[hostname];
        try {
            let response = await axios.get(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
                headers: { accept: 'application/dns-json' },
                timeout: 5000,
                httpsAgent: this.getHttpsAgent(),
            }).catch(() => null);

            if (!response) {
                response = await axios.get(`https://8.8.8.8/resolve?name=${hostname}&type=A`, {
                    timeout: 5000,
                    httpsAgent: this.getHttpsAgent(),
                }).catch(() => null);
            }

            const ip = response?.data?.Answer?.[0]?.data;
            if (ip && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
                this.ipCache[hostname] = ip;
                return ip;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${hostname}] DNS resolution failed: ${msg}`);
        }
        return hostname;
    }

    /**
     * Memeriksa keamanan on-chain (Anti-Rug Guard)
     */
    private async checkOnChainAuthority(tokenMint: string, isPumpFun: boolean): Promise<boolean> {
        const mintPublicKey = new PublicKey(tokenMint);
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const mintInfo = await getMint(this.connection, mintPublicKey);

                // mintAuthority HARUS null (Renounced / Kunci dibuang)
                if (mintInfo.mintAuthority !== null) {
                    this.logger.warn(`[${tokenMint}] 🛑 Mint authority still active. Reject.`);
                    return false;
                }

                // freezeAuthority HARUS null (Disabled)
                if (mintInfo.freezeAuthority !== null) {
                    if (isPumpFun) {
                        this.logger.debug(`[${tokenMint}] ⚠️ Freeze authority active but PumpFun token — TOLERATED.`);
                        return true;
                    }
                    this.logger.warn(`[${tokenMint}] 🛑 Freeze authority active (non-PumpFun). Reject.`);
                    return false;
                }

                return true;
            } catch {
                if (attempt < maxRetries) {
                    await new Promise(res => setTimeout(res, 1000 * attempt));
                }
            }
        }
        return false;
    }

    /**
     * Memeriksa status Liquidity Pool (LP) via RugCheck API
     */
    private async checkRugCheckLP(tokenMint: string, isPumpFun: boolean): Promise<{ passed: boolean; creator?: string; topHolder?: string }> {
        try {
            const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, {
                timeout: 5000,
                httpsAgent: this.getHttpsAgent(),
            });

            if (!response.data) return { passed: false };

            const markets = (response.data.markets as RugCheckMarket[]) || [];
            const lpSafe = markets.some((m: RugCheckMarket) => 
                m.lpType === 'burned' || m.lpStatus === 'burned' || 
                m.lpType === 'locked' || m.lpStatus === 'locked'
            );

            if (!lpSafe && markets.length > 0 && !isPumpFun) {
                this.logger.warn(`[${tokenMint}] 🛑 LP is NOT burned or locked. Reject.`);
                return { passed: false };
            }

            const topHolders = response.data.topHolders || [];
            return {
                passed: true,
                creator: response.data.creator,
                topHolder: topHolders[0]?.address,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] RugCheck API Error: ${msg}`);
            return { passed: false };
        }
    }

    /**
     * Rumus Divergensi Volume-Harga (Trigger Rebound)
     */
    public checkVolumePriceDivergence(pairData: DexScreenerPair): boolean {
        const volumeSpikeRatio = Number.parseFloat(this.configService.get<string>('VOLUME_SPIKE_RATIO', '0.25'));
        const reboundPriceDropPct = Number.parseFloat(this.configService.get<string>('REBOUND_PRICE_DROP_PCT', '-50'));

        const volume5m = pairData.volume?.m5 || 0;
        const volume1h = pairData.volume?.h1 || 0;
        const priceChange5m = pairData.priceChange?.m5 || 0;
        const priceChange24h = pairData.priceChange?.h24 ?? (pairData.priceChange?.h6 || 0); // Fallback ke h6 jika h24 kosong

        // 1. Kondisi Volume Spike: V_5m > V_1h * VOLUME_SPIKE_RATIO
        const isVolumeSpiking = volume5m > (volume1h * volumeSpikeRatio) && volume5m > 500; // Minimal ada volume $500 di 5m

        // 2. Kondisi Lantai Konsolidasi (Flat 5m): Pergerakan harga 5m relatif datar (membentuk support/lantai)
        // Harga tidak boleh lanjut terjun bebas di 5m (harus >= -2%) dan belum terbang jauh (<= +5%)
        const isConsolidating = priceChange5m >= -2.0 && priceChange5m <= 5.0;

        // 3. Kondisi Deep Sell-off (24h drop <= REBOUND_PRICE_DROP_PCT)
        const isDeepSelloff = priceChange24h <= reboundPriceDropPct;

        return isVolumeSpiking && isConsolidating && isDeepSelloff;
    }

    /**
     * Pengecekan Dominasi Pembeli (Buyer Dominance)
     */
    public checkBuyerDominance(pairData: DexScreenerPair): boolean {
        const buySellRatioThreshold = Number.parseFloat(this.configService.get<string>('BUY_SELL_RATIO_THRESHOLD', '1.5'));

        const buys = pairData.txns?.m5?.buys || 0;
        const sells = pairData.txns?.m5?.sells || 0;

        // Kondisi: buys > (sells * BUY_SELL_RATIO_THRESHOLD) AND buys >= 5
        return buys > (sells * buySellRatioThreshold) && buys >= 5;
    }

    /**
     * Endpoint Analisis Utama untuk Token Kandidat
     */
    public async analyzeAndExecuteRebound(tokenMint: string): Promise<boolean> {
        try {
            // 1. Fetch data dari DexScreener
            const response = await axios.get<{ pairs: DexScreenerPair[] }>(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                { timeout: 5000, httpsAgent: this.getHttpsAgent() }
            );

            const pair = response.data?.pairs?.[0];
            if (!pair) return false;

            const minAgeHours = Number.parseFloat(this.configService.get<string>('ESTABLISHED_MIN_AGE_HOURS') ?? this.configService.get<string>('MIN_AGE_HOURS', '24'));
            const maxAgeHours = Number.parseFloat(this.configService.get<string>('ESTABLISHED_MAX_AGE_HOURS') ?? this.configService.get<string>('MAX_AGE_HOURS', '72'));
            const minLiqUsd = Number.parseFloat(this.configService.get<string>('MIN_ESTABLISHED_LIQUIDITY', '3000'));
            const maxMcapUsd = Number.parseFloat(this.configService.get<string>('MAX_ESTABLISHED_MCAP', '200000'));

            const ageHours = (Date.now() - (pair.pairCreatedAt || 0)) / (1000 * 60 * 60);
            const liquidity = pair.liquidity?.usd || 0;
            const marketCap = pair.fdv || 0;
            const symbol = pair.baseToken?.symbol || 'UNKNOWN';

            // Filter Umur & Likuiditas Mapan
            if (ageHours < minAgeHours || ageHours > maxAgeHours) return false;
            if (liquidity < minLiqUsd) return false;
            if (marketCap > maxMcapUsd) return false;

            // 2. Periksa Rumus Divergensi Volume-Harga
            if (!this.checkVolumePriceDivergence(pair)) return false;

            // 3. Periksa Dominasi Pembeli
            if (!this.checkBuyerDominance(pair)) return false;

            // 4. Periksa Keamanan On-Chain (Authority)
            const isPumpFunToken = tokenMint.toLowerCase().endsWith('pump') || pair.info?.websites?.some(w => w.url.includes('pump.fun')) || false;
            const isAuthoritySafe = await this.checkOnChainAuthority(tokenMint, isPumpFunToken);
            if (!isAuthoritySafe) return false;

            // 5. Periksa Status LP RugCheck
            const rugResult = await this.checkRugCheckLP(tokenMint, isPumpFunToken);
            if (!rugResult.passed) return false;

            // 🚀 SEMUA FILTER LOLOS - SIAP EKSEKUSI
            this.logger.log(`📈 CONFIRMED REBOUND SIGNALS for $${symbol} (${tokenMint})! Ready to strike.`);

            const metadata: TokenMetadata = {
                liquidity,
                marketCap,
                mcap: marketCap,
                pairCreatedAt: pair.pairCreatedAt,
                symbol: `$${symbol}`,
                socials: {
                    twitter: pair.info?.socials?.find(s => s.type === 'twitter')?.url,
                    telegram: pair.info?.socials?.find(s => s.type === 'telegram')?.url,
                    website: pair.info?.websites?.[0]?.url,
                },
                creator: rugResult.creator,
                topHolder: rugResult.topHolder,
                isPumpFun: isPumpFunToken,
            };

            // Eksekusi Swap Jupiter V6 dengan Pengaturan Keluar Ketat
            await this.tradeService.attemptBuy(tokenMint, metadata, undefined, {
                customSlippageBps: 300, // Slippage 3%
                priorityFeeSol: 0.0001, // 0.0001 SOL Jito tip / Priority fee
                targetTakeProfit: 18.0, // TP 18% (antara 15% - 20%)
                targetTrailingDistance: 2.5, // Trailing stop 2.5% (antara 2% - 3%)
                targetStopLoss: 20.0, // Hard stop loss 20%
            });

            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] Rebound analysis failed: ${msg}`);
            return false;
        }
    }
}
