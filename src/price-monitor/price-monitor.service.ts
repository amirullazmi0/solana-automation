import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Trade } from '@prisma/client';
import axios from 'axios';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { ReportingService } from '../reporting/reporting.service';
import { TradeService } from '../trade/trade.service';

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

    @Interval(2000)
    async monitorPrices() {
        const openTrades = await this.prismaService.trade.findMany({
            where: { status: 'OPEN' },
        });

        if (openTrades.length === 0) return;

        // 📦 BATCHING: Get all prices in one go
        const mints = openTrades.map(t => t.tokenMint);
        const priceMap = await this.getBatchPrices(mints);

        for (const trade of openTrades) {
            if (this.processingTrades.has(trade.id)) continue;

            const currentPrice = priceMap[trade.tokenMint];
            if (!currentPrice || currentPrice <= 0) continue;

            this.processingTrades.add(trade.id);
            try {
                // DETEKSI RUGPULL (Gua tetep pake 25% drop liq)
                // Karena likuiditas butuh DexScreener (boros kalau tiap 2 detik),
                // kita cek likuiditas cuma tiap 10 detik atau kalau harga drop parah.
                const isPriceDroppingFast = currentPrice < (trade.entryPrice * 0.8); // Drop > 20%
                const entryLiq = trade.entryLiquidity || 0;
                if (entryLiq > 0 && (isPriceDroppingFast || Math.random() < 0.2)) { // 20% chance to check liq
                    const latestLiq = await this.getLiquidityOnly(trade.tokenMint);
                    if (latestLiq && latestLiq > 0) {
                        const liqDrop = ((entryLiq - latestLiq) / entryLiq) * 100;
                        if (liqDrop > 25) {
                            this.logger.warn(`[Slot ${trade.slotNumber}] 🚨 RUGPULL DETECTED! Liquidity dropped ${liqDrop.toFixed(2)}%.`);
                            await this.tradeService.executeSell(trade.id, currentPrice, 'RUGPULL');
                            continue;
                        }
                    }
                }

                // 🕵️ CREATOR WATCHDOG (Anti-Dump)
                if (trade.creatorAddress && trade.initialCreatorBalance > 0) {
                    // Cek saldo creator tiap ~6 detik atau kalau harga turun
                    if (isPriceDroppingFast || Math.random() < 0.3) {
                        const currentDevBal = await this.tradeService.getTokenBalance(trade.creatorAddress, trade.tokenMint);
                        if (currentDevBal !== null) {
                            // Kalau saldo berkurang > 1% dari awal (toleransi dikit buat gas/fee)
                            const devSold = (trade.initialCreatorBalance - currentDevBal) / trade.initialCreatorBalance;
                            if (devSold > 0.01) {
                                this.logger.warn(`[Slot ${trade.slotNumber}] ⚠️ DEV IS DUMPING! Sold ${(devSold * 100).toFixed(2)}% of their bag. Front-running...`);
                                await this.tradeService.executeSell(trade.id, currentPrice, 'DEV_DUMP');
                                continue;
                            }
                        }
                    }
                }

                await this.evaluateTrade(trade, currentPrice);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.error(`Error evaluating ${trade.tokenMint}: ${msg}`);
            } finally {
                this.processingTrades.delete(trade.id);
            }
        }
    }

    private async getBatchPrices(mints: string[]): Promise<Record<string, number>> {
        const result: Record<string, number> = {};
        if (mints.length === 0) return result;

        try {
            const hostname = 'api.jup.ag';
            const ids = mints.join(',');
            const response = await axios.get(`https://${hostname}/price/v2?ids=${ids}`, {
                timeout: 3000,
                headers: { 'x-api-key': this.jupiterApiKey },
                httpsAgent: new https.Agent({ family: 4 })
            });

            const data = response.data?.data || {};
            for (const mint of mints) {
                if (data[mint]?.price) {
                    result[mint] = parseFloat(data[mint].price);
                }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Batch price fetch failed: ${msg}`);
        }
        return result;
    }


    private async getLiquidityOnly(tokenMint: string): Promise<number | null> {
        try {
            const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, { 
                timeout: 5000,
                httpsAgent: new https.Agent({ family: 4 })
            });
            return response.data.pairs?.[0]?.liquidity?.usd || 0;
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
            return null;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${hostname}] DNS resolution failed: ${message}. Safety skip.`);
            return null;
        }
    }

    private async evaluateTrade(trade: Trade, currentPrice: number) {
        const profitPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
        let devDumped = false;

        this.logger.debug(`[Slot ${trade.slotNumber}] Evaluating ${trade.symbol}: Price: $${currentPrice.toFixed(8)}, Profit: ${profitPercent.toFixed(2)}%, SL: -${this.stopLossPercent}%, TSL: $${trade.trailingStopPrice.toFixed(8)}`);


        // 1. RUGPULL PROTECTION (Instant Exit)
        if (profitPercent <= -80) {
            this.logger.error(`[Slot ${trade.slotNumber}] 💀 RUGPULL DETECTED (-80%). IMMEDIATE EXIT.`);
            await this.tradeService.executeSell(trade.id, currentPrice, 'RUGPULL');
            return;
        }

        // 3. TRAILING STOP LOGIC (Update Peak & TSL)
        // 🚀 Hanya update peak kalau harga sudah naik minimal 2% (Safe Zone)
        if (currentPrice > trade.highestPrice && profitPercent >= 2) {
            const calculatedStop = currentPrice * (1 - (this.trailingDistancePercent / 100));
            
            // 🛡️ ZERO-LOSS PROTECTION: Kalau untung >= 10%, jaring jual MINIMAL di harga beli + 1%
            let newTrailingStop = Math.max(calculatedStop, trade.entryPrice);
            if (profitPercent >= 10) {
                const breakEvenPlus = trade.entryPrice * 1.01;
                newTrailingStop = Math.max(newTrailingStop, breakEvenPlus);
            }
            
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

        // 4. EXIT CONDITION: Take Profit or Trailing Stop
        const baseTP = parseFloat(this.configService.get<string>('TAKE_PROFIT_PERCENT', '30.0'));
        
        // 🚀 DYNAMIC TP: Kalau volume lagi "Sakit" (Surge gede), targetin lebih tinggi
        // Kita butuh volumeSurge dari database (Watchlist) kalau ada, atau kita asumsikan dari momentum
        // Untuk sekarang kita pake multiplier kalau highestPrice naik kenceng
        let dynamicTP = baseTP;
        if (profitPercent >= baseTP && trade.highestPrice > trade.entryPrice * 1.5) {
            this.logger.log(`[Slot ${trade.slotNumber}] 🔥 HIGH MOMENTUM DETECTED! Increasing TP target to 60%...`);
            dynamicTP = 60.0; // Serakah dikit karena koin lagi kenceng
        }

        // Trigger TP if price hits target
        if (profitPercent >= dynamicTP) {
            this.logger.log(`[Slot ${trade.slotNumber}] 🎯 TARGET HIT! Exit at ${profitPercent.toFixed(2)}% profit.`);
            await this.tradeService.executeSell(trade.id, currentPrice, 'TAKE_PROFIT');
            return;
        }

        // 🛡️ Trailing Stop Trigger
        if (trade.trailingStopPrice > 0 && currentPrice <= trade.trailingStopPrice && currentPrice > trade.entryPrice) {
            // 🧠 DIAMOND HAND PASS: Kalau Dev masih hold, kasih nafas 3% lagi
            if (!devDumped && trade.creatorAddress) {
                const leniencyPrice = trade.trailingStopPrice * 0.97;
                if (currentPrice > leniencyPrice) {
                    this.logger.log(`[Slot ${trade.slotNumber}] 💎 Dev is holding. Applying Diamond Hand Pass (Waiting for $${leniencyPrice.toFixed(8)})`);
                    return;
                }
            }

            const reason = 'TRAILING_STOP';
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
