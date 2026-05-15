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
            this.configService.get<string>('TRAILING_DISTANCE_PERCENT', '5.0'),
        );
        this.stopLossPercent = parseFloat(
            this.configService.get<string>('STOP_LOSS_PERCENT', '40.0'),
        );
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
    }

    private readonly processingTrades = new Set<number>();

    @Interval(5000)
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
                            await this.tradeService.executeSell(trade.id, stats.price, 'RUGPULL');
                            continue;
                        }
                    }

                    await this.evaluateTrade(trade, stats.price);
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.error(`Error monitoring for ${trade.tokenMint}: ${msg}`);
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
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.debug(`[PriceMonitor] Jupiter Price API error for ${tokenMint}: ${msg}`);
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
        let devDumped = false;

        this.logger.debug(`[Slot ${trade.slotNumber}] Evaluating ${trade.symbol}: Price: $${currentPrice.toFixed(8)}, Profit: ${profitPercent.toFixed(2)}%, SL: -${this.stopLossPercent}%, TSL: $${trade.trailingStopPrice.toFixed(8)}`);


        // 1. ANALISIS HOLDER (Insting Intelijen)
        if (trade.creatorAddress || trade.topHolderAddress) {
            if (trade.creatorAddress) {
                const currentCreatorBalance = await this.tradeService.getTokenBalance(trade.creatorAddress, trade.tokenMint);
                if (typeof currentCreatorBalance === 'number' && trade.initialCreatorBalance) {
                    if (currentCreatorBalance < trade.initialCreatorBalance * 0.5) { // Dev dump 50%
                        this.logger.warn(`[Slot ${trade.slotNumber}] 🔥 EMERGENCY: Developer is dumping! PANIC SELL.`);
                        devDumped = true;
                        await this.tradeService.executeSell(trade.id, currentPrice, 'DEV_DUMP');
                        return;
                    }
                }
            }
            // Top Whale Check (Leniency 15%)
            if (trade.topHolderAddress) {
                const currentTopBalance = await this.tradeService.getTokenBalance(trade.topHolderAddress, trade.tokenMint);
                if (typeof currentTopBalance === 'number' && trade.initialTopHolderBalance) {
                    if (currentTopBalance < trade.initialTopHolderBalance * 0.85) {
                        this.logger.warn(`[Slot ${trade.slotNumber}] 🐋 Whale is dumping!`);
                        // We don't necessarily panic sell on one whale, but we mark it
                    }
                }
            }
        }

        // 2. RUGPULL PROTECTION (Instant Exit)
        if (profitPercent <= -80) {
            this.logger.error(`[Slot ${trade.slotNumber}] 💀 RUGPULL DETECTED (-80%). IMMEDIATE EXIT.`);
            await this.tradeService.executeSell(trade.id, currentPrice, 'RUGPULL');
            return;
        }

        // 3. TRAILING STOP LOGIC (Update Peak & TSL)
        // 🚀 Hanya update peak kalau harga sudah naik minimal 2% (Safe Zone)
        if (currentPrice > trade.highestPrice && profitPercent >= 2) {
            const calculatedStop = currentPrice * (1 - (this.trailingDistancePercent / 100));
            // 🛡️ Fail-safe: Jaring jual (TSL) TIDAK BOLEH lebih rendah dari harga beli
            const newTrailingStop = Math.max(calculatedStop, trade.entryPrice);
            
            await this.prismaService.trade.update({
                where: { id: trade.id },
                data: { highestPrice: currentPrice, trailingStopPrice: newTrailingStop },
            });
            this.logger.debug(`[Slot ${trade.slotNumber}] 📈 New Peak: $${currentPrice.toFixed(8)}. TSL Locked at: $${newTrailingStop.toFixed(8)}`);
            
            // Anti-Spam Trailing Alert
            const now = Date.now();
            const lastAlert = this.lastAlertTime.get(trade.tokenMint) || 0;
            if (profitPercent >= 5 && now - lastAlert > 5 * 60 * 1000) {
                await this.reportingService.sendTrailingAlert(trade.tokenMint, newTrailingStop, currentPrice, trade.symbol || undefined);
                this.lastAlertTime.set(trade.tokenMint, now);
            }
        }

        // 4. EXIT CONDITION: Trailing Stop Reached
        // 🛡️ Hanya trigger Trailing Stop kalau harganya sudah pernah naik (highestPrice > entry)
        // Dan hanya kalau profit > 0 (Biarkan SL Protocol yang handle kerugian murni)
        if (trade.trailingStopPrice > 0 && currentPrice <= trade.trailingStopPrice && currentPrice > trade.entryPrice) {
            // 🧠 DIAMOND HAND PASS: Kalau Dev masih hold, kasih nafas 3% lagi
            if (!devDumped && trade.creatorAddress) {
                const leniencyPrice = trade.trailingStopPrice * 0.97;
                if (currentPrice > leniencyPrice) {
                    this.logger.log(`[Slot ${trade.slotNumber}] 💎 Dev is holding. Applying Diamond Hand Pass (Waiting for $${leniencyPrice.toFixed(8)})`);
                    return;
                }
            }

            const reason = profitPercent > 0 ? 'TAKE_PROFIT' : 'TRAILING_STOP_LOSS';
            this.logger.log(`[Slot ${trade.slotNumber}] 💸 ${reason} at $${currentPrice.toFixed(8)} (Profit: ${profitPercent.toFixed(2)}%)`);
            await this.tradeService.executeSell(trade.id, currentPrice, reason);
            return;
        }

        // 5. EXIT CONDITION: Patience Protocol (10-Minute SL)
        if (profitPercent <= -this.stopLossPercent) {
            // 🛡️ BUY PRESSURE CHECK: Jika masih ada buying pressure kuat, JANGAN JUAL (biarpun timer habis)
            const hasBuyPressure = await this.checkBuyPressure(trade.tokenMint);
            if (hasBuyPressure) {
                this.logger.log(`[Slot ${trade.slotNumber}] 🟢 Buy pressure detected in SL zone! DIAMOND HANDS — Delaying exit...`);
                return;
            }

            if (!trade.slTriggeredAt) {
                this.logger.warn(`[Slot ${trade.slotNumber}] 🛑 Stop Loss zone. Starting 10-minute patience timer...`);
                await this.prismaService.trade.update({
                    where: { id: trade.id },
                    data: { slTriggeredAt: new Date() }
                });
            } else {
                const elapsedMin = (Date.now() - new Date(trade.slTriggeredAt).getTime()) / (1000 * 60);
                if (elapsedMin >= 10) {
                    this.logger.warn(`[Slot ${trade.slotNumber}] 🕒 10 minutes passed with no buy pressure. Executing FINAL STOP LOSS.`);
                    await this.tradeService.executeSell(trade.id, currentPrice, 'STOP_LOSS');
                } else {
                    this.logger.log(`[Slot ${trade.slotNumber}] 🕒 In SL zone. Waiting... (${(10 - elapsedMin).toFixed(1)} min left)`);
                }
            }
        } else {
            // ✅ RECOVERY: Reset SL timer if price recovers
            if (trade.slTriggeredAt) {
                this.logger.log(`[Slot ${trade.slotNumber}] ✨ Price recovered! Resetting SL timer.`);
                await this.prismaService.trade.update({
                    where: { id: trade.id },
                    data: { slTriggeredAt: null }
                });
            }
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
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to check buy pressure: ${msg}`);
            return false;
        }
    }
}
