import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { TradeService } from '../trade/trade.service';
import { ReportingService } from '../reporting/reporting.service';
import { Trade } from '@prisma/client';

@Injectable()
export class PriceMonitorService {
    private readonly logger = new Logger(PriceMonitorService.name);
    private readonly trailingDistancePercent: number;

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly tradeService: TradeService,
        private readonly reportingService: ReportingService,
    ) {
        this.trailingDistancePercent = parseFloat(
            this.configService.get<string>('TRAILING_DISTANCE_PERCENT', '0.5'),
        );
    }

    // Runs every 2 seconds
    @Interval(2000)
    async monitorPrices() {
        const openTrades = await this.prismaService.trade.findMany({
            where: { status: 'OPEN' },
        });

        if (openTrades.length === 0) return;

        for (const trade of openTrades) {
            try {
                const currentPrice = await this.getCurrentPrice(trade.tokenMint);

                await this.evaluateTrade(trade, currentPrice);
            } catch (error) {
                this.logger.error(
                    `Error monitoring price for ${trade.tokenMint}: ${error.message}`,
                );
            }
        }
    }

    private async getCurrentPrice(tokenMint: string): Promise<number> {
        try {
            // Fetch current price from Jupiter Price API V2
            const response = await fetch(`https://api.jup.ag/price/v2?ids=${tokenMint}`);

            if (!response.ok) {
                this.logger.error(`Failed to fetch price for ${tokenMint}: ${response.statusText}`);
                return 0; // Return 0 so it doesn't trigger false sells
            }

            const json = await response.json();

            if (json.data && json.data[tokenMint] && json.data[tokenMint].price) {
                return parseFloat(json.data[tokenMint].price);
            }

            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(
                `[PriceMonitor] Error fetching price for ${tokenMint}: ${message}`,
            );
            return 0;
        }
    }

    private async evaluateTrade(trade: Trade, currentPrice: number) {
        const profitPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

        // 1. Check Stop Loss (10% drop from entry)
        const hardStopLossPrice = trade.entryPrice - trade.entryPrice * 0.1;
        if (currentPrice <= hardStopLossPrice && trade.highestPrice <= trade.entryPrice * 1.05) {
            // Execute Stop Loss if we haven't reached TTP activation (5% profit)
            this.logger.warn(`[Slot ${trade.slotNumber}] Stop Loss Triggered at $${currentPrice}`);
            await this.tradeService.executeSell(trade.id, currentPrice, true);
            return;
        }

        // 2. Trailing Take Profit (TTP) Logic
        // Activate TTP when profit >= 5%
        if (profitPercent >= 5) {
            if (currentPrice > trade.highestPrice) {
                // Price climbed, update highest price and trailing stop price
                const newTrailingStop =
                    currentPrice - currentPrice * (this.trailingDistancePercent / 100);

                await this.prismaService.trade.update({
                    where: { id: trade.id },
                    data: {
                        highestPrice: currentPrice,
                        trailingStopPrice: newTrailingStop,
                    },
                });

                this.logger.log(
                    `[Slot ${trade.slotNumber}] New Highest Price: $${currentPrice}. Updated Trailing Stop: $${newTrailingStop}`,
                );
                await this.reportingService.sendTrailingAlert(
                    trade.tokenMint,
                    newTrailingStop,
                    currentPrice,
                );
            }
        }

        // 3. Execute Sell if price drops to or below Trailing Stop
        // (Only applies if TTP has activated, or we use the initial -10% stop loss)
        if (currentPrice <= trade.trailingStopPrice && profitPercent >= 5) {
            this.logger.log(
                `[Slot ${trade.slotNumber}] Trailing Take Profit Triggered at $${currentPrice}`,
            );
            await this.tradeService.executeSell(trade.id, currentPrice, false);
        }
    }
}
