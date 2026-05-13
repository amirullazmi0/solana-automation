import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TradeService } from '../trade/trade.service';
import { ReportingService } from '../reporting/reporting.service';
import { Trade } from '@prisma/client';
import axios from 'axios';
import * as https from 'https';
import { lookup } from 'dns';

@Injectable()
export class PriceMonitorService {
    private readonly logger = new Logger(PriceMonitorService.name);
    private trailingDistancePercent: number;
    private jupiterApiKey: string;
    private stopLossPercent: number;
    private takeProfitPercent: number;
    // In-memory tracker untuk konfirmasi SL (trade ID -> jumlah konfirmasi)
    private readonly slConfirmCount = new Map<number, number>();
    private readonly lastAlertTime = new Map<string, number>(); // Cooldown alert: tokenMint -> timestamp
    private ipCache: Record<string, string> = {
        'api.jup.ag': '18.239.105.107',
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly tradeService: TradeService,
        private readonly reportingService: ReportingService,
    ) {
        this.trailingDistancePercent = parseFloat(
            this.configService.get<string>('TRAILING_DISTANCE_PERCENT', '1.5'),
        );
        this.stopLossPercent = parseFloat(
            this.configService.get<string>('STOP_LOSS_PERCENT', '40.0'),
        );
        this.takeProfitPercent = parseFloat(
            this.configService.get<string>('TAKE_PROFIT_PERCENT', '20.0'),
        );
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
    }

    private readonly processingTrades = new Set<number>();

    @Interval(2000)
    async monitorPrices() {
        const openTrades = await this.prismaService.trade.findMany({
            where: { status: 'OPEN' },
        });

        if (openTrades.length === 0) return;

        for (const trade of openTrades) {
            // Skip if this trade is already being processed (sold or evaluated)
            if (this.processingTrades.has(trade.id)) continue;

            this.processingTrades.add(trade.id);
            try {
                const stats = await this.getCurrentStats(trade.tokenMint);
                
                if (stats && stats.price > 0) {
                    // DETEKSI RUGPULL: Kalau likuiditas ditarik > 25% (lebih sensitif)
                    if (trade.entryLiquidity && trade.entryLiquidity > 0 && stats.liquidity > 0) {
                        const liqDrop = ((trade.entryLiquidity - stats.liquidity) / trade.entryLiquidity) * 100;
                        if (liqDrop > 25) {
                            this.logger.warn(`[Slot ${trade.slotNumber}] 🚨 RUGPULL DETECTED! Liquidity dropped ${liqDrop.toFixed(2)}%. PANIC SELLING!`);
                            await this.tradeService.executeSell(trade.id, stats.price, true);
                            continue;
                        }
                    }

                    await this.evaluateTrade(trade, stats.price);
                }
            } catch (error) {
                this.logger.error(`Error monitoring for ${trade.tokenMint}: ${error.message}`);
            } finally {
                this.processingTrades.delete(trade.id);
            }
        }
    }

    private async getCurrentStats(tokenMint: string): Promise<{ price: number; liquidity: number } | null> {
        // 1. Ambil Harga dari JUPITER (Prioritas #1 - Super Fast)
        try {
            const hostname = 'api.jup.ag';
            const response = await axios.get(`https://${hostname}/price/v2?ids=${tokenMint}`, {
                timeout: 5000,
                headers: { 'x-api-key': this.jupiterApiKey },
                httpsAgent: new https.Agent({
                    family: 4,
                    lookup: async (h, o, cb) => {
                        const ip = await this.resolveDns(h);
                        if (ip) cb(null, ip, 4); else lookup(h, o, cb);
                    }
                })
            });

            const jupPrice = response.data?.data?.[tokenMint]?.price;
            if (jupPrice) {
                // Harga dapet! Sekarang kita butuh likuiditas (Fallback ke DexScreener atau hitung manual)
                // Sementara likuiditas tetap ambil dari DexScreener karena Jup gak sedia data likuiditas USD
                const dexStats = await this.getLiquidityOnly(tokenMint);
                return { 
                    price: parseFloat(jupPrice), 
                    liquidity: dexStats || 0 
                };
            }
        } catch (error) {
            this.logger.debug(`[PriceMonitor] Jupiter Price API error for ${tokenMint}: ${error.message}`);
        }

        // 2. Fallback total ke DexScreener jika Jupiter bermasalah
        return this.getDexScreenerStats(tokenMint);
    }

    private async getLiquidityOnly(tokenMint: string): Promise<number | null> {
        try {
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, { timeout: 3000 });
            return response.data.pairs?.[0]?.liquidity?.usd || 0;
        } catch {
            return null;
        }
    }

    private async getDexScreenerStats(tokenMint: string): Promise<{ price: number; liquidity: number } | null> {
        try {
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, { timeout: 5000 });
            const pair = response.data.pairs?.[0];
            if (pair) {
                return { 
                    price: parseFloat(pair.priceUsd), 
                    liquidity: pair.liquidity?.usd || 0 
                };
            }
            return null;
        } catch {

            return null;
        }
    }

    private async resolveDns(hostname: string): Promise<string | null> {
        if (this.ipCache[hostname]) return this.ipCache[hostname];
        try {
            let response = await axios
                .get(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
                    headers: { accept: 'application/dns-json' },
                    timeout: 5000,
                    httpsAgent: new https.Agent({ family: 4 }),
                })
                .catch(() => null);

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
                this.ipCache[hostname] = ip;
                return ip;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${hostname}] DNS resolution failed: ${message}. Safety skip.`);
            return null;
         }
        return null;
    }

    private async evaluateTrade(trade: Trade, currentPrice: number) {
        const profitPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
        // const holdingTimeSeconds = (Date.now() - new Date(trade.createdAt).getTime()) / 1000;
        // 0. PANIC SELL: DEV SELL WATCH
        if (trade.creatorAddress || trade.topHolderAddress) {
            if (trade.creatorAddress) {
                const currentCreatorBalance = await this.tradeService.getTokenBalance(trade.creatorAddress, trade.tokenMint);
                // Threshold naik jadi 15% (dari 1%) biar gak baperan
                if (currentCreatorBalance < (trade.initialCreatorBalance || 0) * 0.85) { 
                    this.logger.warn(`[Slot ${trade.slotNumber}] 🚨 DEV IS SELLING! Creator dumped tokens (>15%). PANIC SELLING!`);
                    await this.tradeService.executeSell(trade.id, currentPrice, true);
                    return;
                }
            }
            if (trade.topHolderAddress) {
                const currentTopBalance = await this.tradeService.getTokenBalance(trade.topHolderAddress, trade.tokenMint);
                if (currentTopBalance < (trade.initialTopHolderBalance || 0) * 0.85) {
                    this.logger.warn(`[Slot ${trade.slotNumber}] 🚨 TOP HOLDER IS SELLING! Top whale dumped (>15%). PANIC SELLING!`);
                    await this.tradeService.executeSell(trade.id, currentPrice, true);
                    return;
                }
            }
        }

        // 1. HARD STOP LOSS (Immediate Exit)
        const stopLossThreshold = trade.entryPrice - trade.entryPrice * (this.stopLossPercent / 100);
        
        if (trade.highestPrice <= trade.entryPrice * 1.05) {
            if (currentPrice <= stopLossThreshold) {
                this.logger.warn(`[Slot ${trade.slotNumber}] ❌ Stop Loss hit. Selling immediately at $${currentPrice}`);
                await this.tradeService.executeSell(trade.id, currentPrice, true);
                return;
            }
        }

        // 2. Update Trailing Stop if price hits new highs (Profit >= 3% - Micro Compound Mode)
        if (profitPercent >= 3) {
            if (currentPrice > trade.highestPrice) {
                const newTrailingStop = currentPrice - currentPrice * (this.trailingDistancePercent / 100);
                await this.prismaService.trade.update({
                    where: { id: trade.id },
                    data: { highestPrice: currentPrice, trailingStopPrice: newTrailingStop },
                });

                this.logger.log(`[Slot ${trade.slotNumber}] New High: $${currentPrice}. TSL: $${newTrailingStop}`);
                
                // ANTI-SPAM: Kirim alert trailing stop maksimal 5 menit sekali per token
                const now = Date.now();
                const lastAlert = this.lastAlertTime.get(trade.tokenMint) || 0;
                if (now - lastAlert > 5 * 60 * 1000) {
                    await this.reportingService.sendTrailingAlert(trade.tokenMint, newTrailingStop, currentPrice, trade.symbol || undefined);
                    this.lastAlertTime.set(trade.tokenMint, now);
                }
            }
        }

        // 3. Trailing Stop Loss Check
        if (trade.trailingStopPrice > 0 && currentPrice <= trade.trailingStopPrice) {
            this.logger.warn(`[Slot ${trade.slotNumber}] Trailing Stop Triggered at $${currentPrice}`);
            await this.tradeService.executeSell(trade.id, currentPrice, false);
            return;
        }

        // 4. Quick Take Profit Check
        if (profitPercent >= this.takeProfitPercent) {
            this.logger.log(`[Slot ${trade.slotNumber}] Quick Take Profit hit at $${currentPrice} (+${profitPercent.toFixed(2)}%)`);
            await this.tradeService.executeSell(trade.id, currentPrice, false);
            return;
        }
    }

    private async checkBuyPressure(tokenMint: string): Promise<boolean> {
        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
            const response = await axios.get(url, {
                httpsAgent: new https.Agent({ family: 4 }),
                timeout: 5000,
            });

            const pair = response.data.pairs?.[0];
            if (!pair?.txns?.m5) return false;

            const buys = pair.txns.m5.buys || 0;
            const sells = pair.txns.m5.sells || 0;

            // Jika pembeli > 2x penjual dalam 5 menit terakhir, berarti ada tekanan beli kuat
            if (buys > sells * 2 && buys > 5) {
                return true;
            }

            return false;
        } catch (error) {
            this.logger.error(`Failed to check buy pressure: ${error.message}`);
            return false;
        }
    }
}
