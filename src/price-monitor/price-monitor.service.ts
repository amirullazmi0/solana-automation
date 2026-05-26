import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Trade } from '@prisma/client';
import axios from 'axios';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { ReportingService } from '../reporting/reporting.service';
import { TradeService } from '../trade/trade.service';
import { DexLimiter } from '../common/dex-limiter';

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
            this.configService.get<string>('STOP_LOSS_PERCENT', '25.0'),
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
        const mints = openTrades.map((t) => t.tokenMint);
        const priceMap = await this.getBatchPrices(mints);

        for (const trade of openTrades) {
            if (this.processingTrades.has(trade.id)) continue;

            const currentPrice = priceMap[trade.tokenMint];
            if (!currentPrice || currentPrice <= 0) continue;

            this.processingTrades.add(trade.id);
            try {
                await this.evaluateTrade(trade, currentPrice);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.error(`Error evaluating ${trade.tokenMint}: ${msg}`);
            } finally {
                this.processingTrades.delete(trade.id);
            }
        }
    }

    private getHttpsAgent() {
        return new https.Agent({
            family: 4,
            keepAlive: true,
            lookup: async (hostname, options, cb) => {
                try {
                    const ip = await this.resolveDns(hostname);
                    if (ip) {
                        cb(null, ip, 4);
                    } else {
                        import('dns')
                            .then(({ lookup }) => {
                                lookup(hostname, options, cb);
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

    private async getBatchPrices(mints: string[]): Promise<Record<string, number>> {
        const result: Record<string, number> = {};
        if (mints.length === 0) return result;

        try {
            const hostname = 'api.jup.ag';
            const ids = mints.join(',');
            const response = await axios.get(`https://${hostname}/price/v3?ids=${ids}`, {
                timeout: 3000,
                headers: { 'x-api-key': this.jupiterApiKey },
                httpsAgent: this.getHttpsAgent(),
            });

            const data = response.data as Record<string, { usdPrice?: number } | undefined> | null;
            if (data) {
                for (const mint of mints) {
                    const tokenData = data[mint];
                    if (tokenData && typeof tokenData.usdPrice === 'number') {
                        result[mint] = tokenData.usdPrice;
                    }
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
            const response = await DexLimiter.get<{
                pairs: Array<{ liquidity?: { usd?: number } }>;
            }>(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
                timeout: 5000,
                httpsAgent: this.getHttpsAgent(),
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

        const effectiveStopLossPercent = trade.targetStopLoss ?? this.stopLossPercent;
        const effectiveTrailingDistancePercent =
            trade.targetTrailingDistance ?? this.trailingDistancePercent;

        this.logger.debug(
            `[Slot ${trade.slotNumber}] Evaluating ${trade.symbol}: Price: $${currentPrice.toFixed(8)}, Profit: ${profitPercent.toFixed(2)}%, SL: -${effectiveStopLossPercent}%, TSL: $${trade.trailingStopPrice.toFixed(8)}`,
        );

        // 1. ANALISIS HOLDER (Insting Intelijen)
        if (trade.creatorAddress || trade.topHolderAddress) {
            if (trade.creatorAddress) {
                const currentCreatorBalance = await this.tradeService.getTokenBalance(
                    trade.creatorAddress,
                    trade.tokenMint,
                );
                if (typeof currentCreatorBalance === 'number' && trade.initialCreatorBalance) {
                    if (currentCreatorBalance < trade.initialCreatorBalance * 0.8) {
                        // Dev dump > 20% (Lebih sensitif buat modal kecil)
                        this.logger.warn(
                            `[Slot ${trade.slotNumber}] 🔥 EMERGENCY: Developer is dumping! PANIC SELL.`,
                        );
                        await this.tradeService.executeSell(trade.id, currentPrice, 'DEV_DUMP');
                        return;
                    }
                }
            }
            // Top Whale Check (Leniency 15%)
            if (trade.topHolderAddress) {
                const currentTopBalance = await this.tradeService.getTokenBalance(
                    trade.topHolderAddress,
                    trade.tokenMint,
                );
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
            this.logger.error(
                `[Slot ${trade.slotNumber}] 💀 RUGPULL DETECTED (-80%). IMMEDIATE EXIT.`,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, 'RUGPULL');
            return;
        }

        // 3. TRAILING STOP LOGIC (Update Peak & TSL)
        // 🚀 Hanya update peak kalau harga sudah naik minimal 5% (Safe Zone)
        if (currentPrice > trade.highestPrice && profitPercent >= 5) {
            const calculatedStop = currentPrice * (1 - effectiveTrailingDistancePercent / 100);

            // Jarak trailing stop murni dari peak tanpa floor buatan di awal
            let newTrailingStop = calculatedStop;

            // 🛡️ ZERO-LOSS PROTECTION: Hanya kunci profit minimal +2% (untuk cover fee) jika koin sudah terbang >= 15%
            if (profitPercent >= 15) {
                const breakEvenPlus = trade.entryPrice * 1.02;
                newTrailingStop = Math.max(newTrailingStop, breakEvenPlus);
            }

            await this.prismaService.trade.update({
                where: { id: trade.id },
                data: { highestPrice: currentPrice, trailingStopPrice: newTrailingStop },
            });
            this.logger.debug(
                `[Slot ${trade.slotNumber}] 📈 New Peak: $${currentPrice.toFixed(8)}. TSL Locked at: $${newTrailingStop.toFixed(8)}`,
            );

            // Anti-Spam Trailing Alert
            const now = Date.now();
            const lastAlert = this.lastAlertTime.get(trade.tokenMint) || 0;
            if (profitPercent >= 5 && now - lastAlert > 5 * 60 * 1000) {
                await this.reportingService.sendTrailingAlert(
                    trade.tokenMint,
                    newTrailingStop,
                    currentPrice,
                    trade.symbol || undefined,
                );
                this.lastAlertTime.set(trade.tokenMint, now);
            }
        }

        // 4. EXIT CONDITION: Take Profit or Trailing Stop
        const baseTP =
            trade.targetTakeProfit ??
            parseFloat(this.configService.get<string>('TAKE_PROFIT_PERCENT', '30.0'));

        // 🚀 DYNAMIC TP: Kalau volume lagi "Sakit" (Surge gede), targetin lebih tinggi
        // Kita butuh volumeSurge dari database (Watchlist) kalau ada, atau kita asumsikan dari momentum
        // Untuk sekarang kita pake multiplier kalau highestPrice naik kenceng
        let dynamicTP = baseTP;
        if (profitPercent >= baseTP && trade.highestPrice > trade.entryPrice * 1.35) {
            this.logger.log(
                `[Slot ${trade.slotNumber}] 🔥 HIGH MOMENTUM DETECTED! Increasing TP target to 50%...`,
            );
            dynamicTP = 50.0; // Target lebih realistis untuk microcap
        }

        // Trigger TP if price hits target
        if (profitPercent >= dynamicTP) {
            this.logger.log(
                `[Slot ${trade.slotNumber}] 🎯 TARGET HIT! Exit at ${profitPercent.toFixed(2)}% profit.`,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, 'TAKE_PROFIT');
            return;
        }

        // 🛡️ Trailing Stop Trigger
        if (trade.trailingStopPrice > 0 && currentPrice <= trade.trailingStopPrice) {
            const reason = 'TRAILING_STOP';
            this.logger.log(
                `[Slot ${trade.slotNumber}] 💸 ${reason} at $${currentPrice.toFixed(8)} (Profit: ${profitPercent.toFixed(2)}%)`,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, reason);
            return;
        }

        // 5. EXIT CONDITION: Patience Protocol (5-Minute SL with 10-Minute Hard Cap)
        if (profitPercent <= -effectiveStopLossPercent) {
            const disablePatience =
                this.configService.get<string>('DISABLE_SL_PATIENCE', 'true') === 'true';

            // Bypass patience protocol if disabled globally or if this is a standard trade (no targetStopLoss override)
            if (disablePatience || !trade.targetStopLoss) {
                this.logger.error(
                    `[Slot ${trade.slotNumber}] 💀 STOP LOSS TRIGGERED (${profitPercent.toFixed(2)}%). Bypassing patience protocol and executing IMMEDIATE STOP LOSS.`,
                );
                await this.tradeService.executeSell(trade.id, currentPrice, 'STOP_LOSS');
                return;
            }

            // Jika crash sangat parah (misal drop di bawah -55%), langsung exit tanpa delay
            if (profitPercent <= -55.0) {
                this.logger.error(
                    `[Slot ${trade.slotNumber}] 💀 HEAVY CRASH DETECTED (${profitPercent.toFixed(2)}%). Bypassing patience protocol and executing IMMEDIATE STOP LOSS.`,
                );
                await this.tradeService.executeSell(trade.id, currentPrice, 'STOP_LOSS');
                return;
            }

            if (!trade.slTriggeredAt) {
                this.logger.warn(
                    `[Slot ${trade.slotNumber}] 🛑 Stop Loss zone. Starting 5-minute patience timer (Hard Cap 10-min)...`,
                );
                await this.prismaService.trade.update({
                    where: { id: trade.id },
                    data: { slTriggeredAt: new Date() },
                });
                return; // Tunggu di iterasi ini
            }

            const elapsedMin = (Date.now() - new Date(trade.slTriggeredAt).getTime()) / (1000 * 60);

            if (elapsedMin >= 5) {
                // Check buy pressure untuk melonggarkan waktu jual (Diamond Hands)
                const hasBuyPressure = await this.checkBuyPressure(trade.tokenMint);
                if (hasBuyPressure && elapsedMin < 10) {
                    this.logger.log(
                        `[Slot ${trade.slotNumber}] 🟢 Buy pressure detected in SL zone! DIAMOND HANDS — Delaying exit... (${(10 - elapsedMin).toFixed(1)} min left to Hard Cap)`,
                    );
                    return;
                }

                this.logger.warn(
                    `[Slot ${trade.slotNumber}] 🕒 ${elapsedMin >= 10 ? '10 minutes Hard Cap reached' : '5 minutes passed with no buy pressure'}. Executing FINAL STOP LOSS.`,
                );
                await this.tradeService.executeSell(trade.id, currentPrice, 'STOP_LOSS');
            } else {
                this.logger.log(
                    `[Slot ${trade.slotNumber}] 🕒 In SL zone. Waiting... (${(5 - elapsedMin).toFixed(1)} min left of initial timer)`,
                );
            }
        } else {
            // ✅ RECOVERY: Reset SL timer if price recovers
            if (trade.slTriggeredAt) {
                this.logger.log(
                    `[Slot ${trade.slotNumber}] ✨ Price recovered! Resetting SL timer.`,
                );
                await this.prismaService.trade.update({
                    where: { id: trade.id },
                    data: { slTriggeredAt: null },
                });
            }
        }
    }

    private async checkBuyPressure(tokenMint: string): Promise<boolean> {
        try {
            const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
            interface DexPair {
                txns?: {
                    m5?: {
                        buys?: number;
                        sells?: number;
                    };
                };
            }
            const response = await DexLimiter.get<{ pairs: DexPair[] }>(url, {
                httpsAgent: this.getHttpsAgent(),
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
