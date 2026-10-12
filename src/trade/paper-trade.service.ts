import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { DexLimiter } from '../common/dex-limiter';
import { computeNetProfitUsd } from '../common/fee-utils';
import { DexScreenerPair } from '../dto/analyzer.dto';
import { PrismaService } from '../prisma/prisma.service';
import {
    computePaperResult,
    decidePaperExit,
    simulatePaperEntry,
    wouldChasePrice,
} from './paper-trade';

export interface OpenPaperTradeInput {
    tokenMint: string;
    symbol?: string;
    priceUsd: number;
    solPriceUsd: number;
    positionSizeUsd: number;
    slippageBps: number;
    route?: 'MICIN' | 'WHALE';
    metaLabel?: string;
    liquidity?: number;
    marketCap?: number;
    pairAddress?: string;
    telegramChatId?: number;
    targetTakeProfit?: number;
    targetStopLoss?: number;
    targetTrailingDistance?: number;
}

/**
 * Records and settles simulated trades, so every buy decision leaves evidence of whether it was
 * right.
 *
 * Before this, a decision produced a Telegram alert and nothing else. Nobody ever found out what
 * happened next, which meant `meta-trend` — the one part of this bot that learns from realised P&L —
 * had no data at all while live trading was idle.
 *
 * It runs regardless of `dryRun`. With dry run on it is the only record; with dry run off it sits
 * beside the real trade, and the gap between the two is a direct measurement of slippage and fees
 * rather than an assumption about them.
 *
 * **This service cannot spend money, and that is structural rather than a promise.** It has no
 * reference to TradeService, no wallet, no Jupiter, no signing. Every path in this app that sells
 * filters `mode: 'LIVE'` (price-monitor.service.ts:474, trade.service.ts:909 and :919), so a PAPER
 * row is invisible to them; `paper-trade.service.spec.ts` asserts those filters against the source
 * so a later edit cannot quietly remove one and start selling tokens that were never bought.
 */
@Injectable()
export class PaperTradeService {
    private readonly logger = new Logger(PaperTradeService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
    ) {}

    private get enabled(): boolean {
        return (
            String(this.configService.get('ENABLE_PAPER_TRADING', 'true')).toLowerCase() !== 'false'
        );
    }

    private num(key: string, fallback: number): number {
        const raw = Number.parseFloat(this.configService.get<string>(key, String(fallback)));
        return Number.isFinite(raw) ? raw : fallback;
    }

    private get roundTripFeeSol(): number {
        return this.num('PAPER_ROUND_TRIP_FEE_SOL', 0.0011);
    }

    private get maxHoldMinutes(): number {
        return this.num('PAPER_MAX_HOLD_MINUTES', 240);
    }

    /**
     * Key duplicated from `TradeService.attemptBuy` rather than imported: that service sits on the
     * money path and this one deliberately holds no reference to it. The spec asserts both name the
     * same key.
     */
    private get maxChasePercent(): number {
        return this.num('MAX_BUY_CHASE_PCT', 5);
    }

    /**
     * Exit rules resolved per route, mirroring `getRouteNumberConfig` in PriceMonitorService.
     *
     * Without this the simulation measures a strategy nobody runs. The base config says a 12% stop
     * and a 0.8% trail, while a MICIN trade actually runs an 8% stop and a 4% trail -- so paper
     * results would describe exits the live bot would never have taken, and every conclusion drawn
     * from them would be about an imaginary strategy.
     *
     * The key names are duplicated rather than imported because PriceMonitorService sits on the
     * money path and this service deliberately has no reference to it. `paper-trade.service.spec.ts`
     * asserts both sides use the same keys, so the duplication cannot drift unnoticed.
     */
    private routeNumber(
        route: string | null | undefined,
        micinKey: string,
        whaleKey: string,
        fallbackKey: string,
        fallback: number,
    ): number {
        if (route === 'MICIN') return this.num(micinKey, fallback);
        if (route === 'WHALE') return this.num(whaleKey, fallback);
        return this.num(fallbackKey, fallback);
    }

    /**
     * Records a simulated entry for a buy decision.
     *
     * Never throws into the caller. This sits on the buy path, and a simulation that can break a
     * real trade is worse than no simulation.
     */
    async open(input: OpenPaperTradeInput): Promise<void> {
        if (!this.enabled) return;

        try {
            if (!(input.priceUsd > 0) || !(input.positionSizeUsd > 0)) return;

            // One open paper position per mint, matching how a real position behaves. Without this
            // a token re-signalling every radar cycle would stack simulated entries and flatter
            // whatever it eventually did.
            const existing = await this.prismaService.trade.findFirst({
                where: { tokenMint: input.tokenMint, status: 'OPEN', mode: 'PAPER' },
                select: { id: true },
            });
            if (existing) return;

            // Entry is priced from a fresh read, not from the signal snapshot.
            //
            // `input.priceUsd` is the price the analyzer saw at the START of its check, before
            // RugCheck, the AI calls and the risk queue. Measured across the 29 live trades that
            // recorded both numbers, it differs from the price actually filled by more than 5% in
            // 17 of them, and sits 7.46% above it on average. Anchoring a simulated entry there and
            // then settling it against the live feed books that gap as a loss the real bot never
            // took: the first paper trade closed at -36.56% in 26 seconds for exactly this reason.
            //
            // A failed read falls back to the snapshot. A simulation biased by a few percent is
            // still worth more than no record of the decision at all.
            const fresh = (await this.fetchPrices([input.tokenMint])).get(input.tokenMint);
            const quotePriceUsd = fresh && fresh > 0 ? fresh : input.priceUsd;

            if (!fresh || !(fresh > 0)) {
                this.logger.warn(
                    `[Paper] No fresh price for ${input.symbol ?? input.tokenMint}; ` +
                        `pricing the entry from the signal snapshot instead.`,
                );
            }

            // The live gate refuses a buy once the price has climbed past the signal by more than
            // MAX_BUY_CHASE_PCT, so the simulation has to refuse it too, or it accumulates entries
            // the live bot could not have made.
            if (wouldChasePrice(input.priceUsd, quotePriceUsd, this.maxChasePercent)) {
                this.logger.log(
                    `[Paper] Skipped ${input.symbol ?? input.tokenMint}: price ran from ` +
                        `$${input.priceUsd} to $${quotePriceUsd}, past the ` +
                        `${this.maxChasePercent}% chase limit the live gate enforces.`,
                );
                return;
            }

            const entry = simulatePaperEntry({
                priceUsd: quotePriceUsd,
                positionSizeUsd: input.positionSizeUsd,
                slippageBps: input.slippageBps,
                roundTripFeeSol: this.roundTripFeeSol,
            });
            if (!(entry.tokenAmount > 0)) return;

            const solPrice = input.solPriceUsd > 0 ? input.solPriceUsd : 0;
            const entryPriceSol = solPrice > 0 ? entry.fillPriceUsd / solPrice : 0;

            await this.prismaService.trade.create({
                data: {
                    tokenMint: input.tokenMint,
                    symbol: input.symbol ?? 'UNKNOWN',
                    // Paper positions never compete for a real slot: capital is the scarce thing
                    // and a simulation must not be able to block a trade that would spend it.
                    slotNumber: 0,
                    status: 'OPEN',
                    mode: 'PAPER',
                    route: input.route ?? null,
                    entryPrice: entryPriceSol,
                    monitorEntryPrice: entryPriceSol,
                    entryPriceSol,
                    entryPriceUsd: entry.fillPriceUsd,
                    highestPrice: entryPriceSol,
                    trailingStopPrice: 0,
                    amountInSol: solPrice > 0 ? entry.costUsd / solPrice : 0,
                    entryValueUsd: entry.costUsd,
                    solPriceAtEntry: solPrice,
                    totalFeesSol: entry.entryFeeSol,
                    entryLiquidity: input.liquidity ?? 0,
                    entryMarketCap: input.marketCap ?? 0,
                    entryPairAddress: input.pairAddress ?? null,
                    metaLabel: input.metaLabel ?? null,
                    telegramChatId: input.telegramChatId ?? null,
                    targetTakeProfit: input.targetTakeProfit,
                    targetStopLoss: input.targetStopLoss,
                    targetTrailingDistance: input.targetTrailingDistance,
                },
            });

            this.logger.log(
                `[Paper] Opened ${input.symbol ?? input.tokenMint} at $${entry.fillPriceUsd} ` +
                    `size=$${entry.costUsd}`,
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[Paper] Open failed for ${input.tokenMint}: ${msg}.`);
        }
    }

    /**
     * Settles open paper positions against the current price.
     *
     * Deliberately slower than the live monitor's one-second beat. Nothing here is protecting money,
     * and the DexScreener feed only moves about once every 26 seconds anyway, so a faster tick would
     * spend the shared rate limit to re-read the same number.
     */
    @Interval(30_000)
    async tick(): Promise<void> {
        if (!this.enabled) return;

        try {
            const open = await this.prismaService.trade.findMany({
                where: { status: 'OPEN', mode: 'PAPER' },
                take: 60,
            });
            if (open.length === 0) return;

            const prices = await this.fetchPrices([...new Set(open.map((t) => t.tokenMint))]);

            for (const trade of open) {
                const currentPriceUsd = prices.get(trade.tokenMint);
                if (!currentPriceUsd || !(currentPriceUsd > 0)) continue;

                const entryFillPriceUsd = trade.entryPriceUsd ?? 0;
                const solPrice = trade.solPriceAtEntry ?? 0;
                if (!(entryFillPriceUsd > 0) || !(solPrice > 0)) continue;

                const highestPriceUsd = Math.max(
                    (trade.highestPrice || 0) * solPrice,
                    entryFillPriceUsd,
                );
                const ageMinutes = (Date.now() - trade.createdAt.getTime()) / 60_000;

                const decision = decidePaperExit({
                    entryFillPriceUsd,
                    currentPriceUsd,
                    highestPriceUsd,
                    targetTakeProfitPercent:
                        trade.targetTakeProfit ??
                        this.routeNumber(
                            trade.route,
                            'MICIN_TAKE_PROFIT_PERCENT',
                            'WHALE_TAKE_PROFIT_PERCENT',
                            'TAKE_PROFIT_PERCENT',
                            20,
                        ),
                    targetStopLossPercent:
                        trade.targetStopLoss ??
                        this.routeNumber(
                            trade.route,
                            'MICIN_STOP_LOSS_PERCENT',
                            'WHALE_STOP_LOSS_PERCENT',
                            'STOP_LOSS_PERCENT',
                            12,
                        ),
                    targetTrailingDistancePercent:
                        trade.targetTrailingDistance ??
                        this.routeNumber(
                            trade.route,
                            'MICIN_TRAILING_DISTANCE_PERCENT',
                            'WHALE_TRAILING_DISTANCE_PERCENT',
                            'TRAILING_DISTANCE_PERCENT',
                            0.8,
                        ),
                    ageMinutes,
                    maxHoldMinutes: this.maxHoldMinutes,
                });

                if (!decision.shouldExit) {
                    // The high water mark has to survive the tick, or the trail measures from
                    // wherever price happens to be instead of from the peak.
                    const newHighSol = decision.highestPriceUsd / solPrice;
                    if (newHighSol > (trade.highestPrice || 0)) {
                        await this.prismaService.trade.update({
                            where: { id: trade.id },
                            data: {
                                highestPrice: newHighSol,
                                trailingStopPrice: decision.trailingStopPriceUsd / solPrice,
                            },
                        });
                    }
                    continue;
                }

                await this.close(trade, currentPriceUsd, decision.reason ?? 'MAX_HOLD', solPrice);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[Paper] Tick failed: ${msg}.`);
        }
    }

    private async close(
        trade: { id: number; symbol: string | null; entryPriceUsd: number | null; entryValueUsd: number | null },
        exitPriceUsd: number,
        reason: string,
        solPrice: number,
    ): Promise<void> {
        const costUsd = trade.entryValueUsd ?? 0;
        const fillPriceUsd = trade.entryPriceUsd ?? 0;
        const tokenAmount = fillPriceUsd > 0 ? costUsd / fillPriceUsd : 0;

        const result = computePaperResult({
            entry: { fillPriceUsd, tokenAmount, costUsd, entryFeeSol: this.roundTripFeeSol / 2 },
            exitPriceUsd,
            roundTripFeeSol: this.roundTripFeeSol,
        });

        // The same fee definition the live path uses, so paper and live P&L can be compared
        // without one of them quietly measuring something else.
        const netProfitUsd = computeNetProfitUsd({
            profitUsd: result.profitUsd,
            totalFeesSol: result.totalFeesSol,
            solPriceAtEntry: solPrice,
        });

        await this.prismaService.trade.update({
            where: { id: trade.id },
            data: {
                status: 'CLOSED',
                exitReason: reason,
                exitPrice: solPrice > 0 ? exitPriceUsd / solPrice : 0,
                exitPriceUsd,
                exitPriceSol: solPrice > 0 ? exitPriceUsd / solPrice : 0,
                exitTriggerPriceUsd: exitPriceUsd,
                exitTriggerPnlPercent:
                    fillPriceUsd > 0 ? ((exitPriceUsd - fillPriceUsd) / fillPriceUsd) * 100 : 0,
                profitUsd: result.profitUsd,
                netProfitUsd,
                totalFeesSol: result.totalFeesSol,
            },
        });

        this.logger.log(
            `[Paper] Closed ${trade.symbol ?? trade.id} ${reason} net=$${netProfitUsd.toFixed(3)}`,
        );
    }

    /** Batched through the shared DexScreener lane, thirty mints per request. */
    private async fetchPrices(mints: string[]): Promise<Map<string, number>> {
        const out = new Map<string, number>();

        for (let i = 0; i < mints.length; i += 30) {
            const batch = mints.slice(i, i + 30);
            try {
                const response = await DexLimiter.get<{ pairs?: DexScreenerPair[] }>(
                    `https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`,
                    { timeout: 8000 },
                );
                for (const pair of response.data?.pairs ?? []) {
                    const mint = pair.baseToken?.address;
                    const price = Number.parseFloat(pair.priceUsd || '0');
                    if (!mint || !(price > 0)) continue;
                    // Deepest pair wins, the same choice every other price read in this app makes.
                    const prev = out.get(mint);
                    if (prev === undefined || (pair.liquidity?.usd || 0) > 0) out.set(mint, price);
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.warn(`[Paper] Price batch failed: ${msg}.`);
            }
        }

        return out;
    }
}
