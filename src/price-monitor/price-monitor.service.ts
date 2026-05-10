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
    private readonly trailingDistancePercent: number;
    private readonly jupiterApiKey: string;
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
            this.configService.get<string>('TRAILING_DISTANCE_PERCENT', '0.5'),
        );
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
    }

    // Ambil harga setiap 5 detik (dikurangi dari 2 detik biar nggak kena rate limit 429)
    @Interval(5000)
    async monitorPrices() {
        const openTrades = await this.prismaService.trade.findMany({
            where: { status: 'OPEN' },
        });

        if (openTrades.length === 0) return;

        for (const trade of openTrades) {
            try {
                const currentPrice = await this.getCurrentPrice(trade.tokenMint);
                
                // Jika harga gagal diambil (null/0), jangan evaluasi agar tidak panic sell
                if (currentPrice && currentPrice > 0) {
                    await this.evaluateTrade(trade, currentPrice);
                }
            } catch (error) {
                this.logger.error(
                    `Error monitoring price for ${trade.tokenMint}: ${error.message}`,
                );
            }
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
        } catch { /* Silence */ }
        return null;
    }

    private async getCurrentPrice(tokenMint: string): Promise<number | null> {
        // 1. Coba Jupiter Price API dulu (VIP/Paid)
        try {
            const hostname = 'api.jup.ag';
            const response = await axios.get(`https://${hostname}/price/v2?ids=${tokenMint}`, {
                timeout: 5000,
                headers: { 'x-api-key': this.jupiterApiKey },
                httpsAgent: new https.Agent({
                    family: 4,
                    lookup: async (h, o, cb) => {
                        try {
                            const ip = await this.resolveDns(h);
                            if (ip) cb(null, ip, 4);
                            else lookup(h, o, cb);
                        } catch (e) { cb(e as Error, '', 4); }
                    }
                })
            });

            const data = response.data;
            if (data.data && data.data[tokenMint] && data.data[tokenMint].price) {
                return parseFloat(data.data[tokenMint].price);
            }
        } catch (error) {
            // Jika 404, artinya koin terlalu baru bagi Jupiter, lanjut ke DexScreener
            if (!axios.isAxiosError(error) || error.response?.status !== 404) {
                this.logger.debug(`Jupiter Price API error for ${tokenMint}: ${error.message}`);
            }
        }

        // 2. Fallback ke DexScreener (Sangat cepat buat koin baru)
        try {
            const hostname = 'api.dexscreener.com';
            const response = await axios.get(`https://${hostname}/latest/dex/tokens/${tokenMint}`, {
                timeout: 5000,
                httpsAgent: new https.Agent({
                    family: 4,
                    lookup: async (h, o, cb) => {
                        try {
                            const ip = await this.resolveDns(h);
                            if (ip) cb(null, ip, 4);
                            else lookup(h, o, cb);
                        } catch (e) { cb(e as Error, '', 4); }
                    }
                })
            });

            const pairs = response.data.pairs;
            if (pairs && pairs.length > 0) {
                // Ambil harga dari pair pertama (biasanya yang paling liquid)
                const price = parseFloat(pairs[0].priceUsd);
                if (price > 0) {
                    this.logger.log(`[PriceMonitor] Used DexScreener fallback for ${tokenMint}: $${price}`);
                    return price;
                }
            }
        } catch (error) {
            this.logger.debug(`[PriceMonitor] DexScreener error for ${tokenMint}: ${error.message}`);
            this.logger.error(`[PriceMonitor] All price sources failed for ${tokenMint}`);
        }

        return null;
    }

    private async evaluateTrade(trade: Trade, currentPrice: number) {
        const profitPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

        // 1. Check Stop Loss (10% drop from entry)
        // Jika koin belum pernah naik signifikan (Trailing belum aktif)
        const hardStopLossPrice = trade.entryPrice - trade.entryPrice * 0.1;
        if (trade.highestPrice <= trade.entryPrice * 1.05) {
            if (currentPrice <= hardStopLossPrice) {
                this.logger.warn(`[Slot ${trade.slotNumber}] Hard Stop Loss Triggered at $${currentPrice} (-10%)`);
                await this.tradeService.executeSell(trade.id, currentPrice, true);
                return;
            }
        }

        // 2. Update Trailing Stop if price hits new highs (Profit >= 5%)
        if (profitPercent >= 5) {
            if (currentPrice > trade.highestPrice) {
                const newTrailingStop = currentPrice - currentPrice * (this.trailingDistancePercent / 100);
                await this.prismaService.trade.update({
                    where: { id: trade.id },
                    data: { highestPrice: currentPrice, trailingStopPrice: newTrailingStop },
                });

                this.logger.log(`[Slot ${trade.slotNumber}] New High: $${currentPrice}. TSL: $${newTrailingStop}`);
                await this.reportingService.sendTrailingAlert(trade.tokenMint, newTrailingStop, currentPrice, trade.symbol || undefined);
            }
        }

        // 3. Execute Sell if price drops to or below Trailing Stop
        // PENTING: Hapus syarat profitPercent >= 5 supaya kalau harga terjun bebas tetap terjual!
        if (currentPrice <= trade.trailingStopPrice) {
            this.logger.log(`[Slot ${trade.slotNumber}] Trailing Stop Triggered at $${currentPrice}`);
            await this.tradeService.executeSell(trade.id, currentPrice, false);
        }
    }
}
