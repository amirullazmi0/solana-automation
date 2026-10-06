import { Controller, Get, Headers, HttpStatus, Logger, Param, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { DexScreenerPair } from '../dto/analyzer.dto';
import { MetaLabelService } from '../meta/meta-label.service';
import { MetaTrendService } from '../meta/meta-trend.service';
import { PrismaService } from '../prisma/prisma.service';
import { CandleService } from './candle.service';
import { RiskService } from './risk.service';
import { buildRiskTags } from './risk-tags';
import { busiestFromFeed, lookupPairs } from './pair-lookup';
import { computeShvedZones, distancePct, minimumCandles, resolveNearestZones } from './shved-zones';
import { predictNextMove } from './next-move';
import { buildTradePlans } from './trade-plans';
import { adviseOnZones } from './zone-advice';

/**
 * Read-only JSON for the zone dashboard.
 *
 * Split into a heavy route and a light one on purpose, because the two things on screen move at
 * completely different speeds. A five-minute candle only changes every five minutes, and
 * GeckoTerminal allows roughly thirty requests a minute — polling it every second would burn the
 * budget to redraw an identical chart. The live price does move continuously, and it comes from
 * DexScreener through a cache measured in seconds. So the page refreshes price often and candles
 * rarely, and still looks alive.
 *
 * Nothing here writes. No buy, no sell, no config change.
 */
@Controller('dashboard/api')
export class DashboardController {
    private readonly logger = new Logger(DashboardController.name);
    private readonly apiSecretKey: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly candleService: CandleService,
        private readonly riskService: RiskService,
        private readonly prismaService: PrismaService,
        private readonly metaTrendService: MetaTrendService,
        private readonly metaLabelService: MetaLabelService,
    ) {
        this.apiSecretKey = this.configService.get<string>('API_SECRET_KEY', '');
    }

    /**
     * Mirrors the inline check in `app.controller.ts`, including its fail-closed stance: an unset
     * `API_SECRET_KEY` rejects everything rather than opening the route.
     *
     * Deliberately unlike the Helius webhook, which answers `200 OK` on bad auth so Helius will not
     * disable itself. That trade-off makes sense for a webhook and is exactly wrong here — this app
     * is public, and these routes expose the watchlist and candidate list.
     */
    private authorised(apiKey: string | undefined, res: Response): boolean {
        // `ENABLE_DASHBOARD=false` has to silence these routes too, not just the static page. The
        // flag is named for the whole feature, and a dashboard that is "off" while its API still
        // answers -- and still lists the watchlist -- is exactly the kind of surprise a kill switch
        // exists to prevent. 404 rather than 401: when the feature is off the route does not exist.
        if (!this.dashboardEnabled) {
            res.status(HttpStatus.NOT_FOUND).json({ message: 'Dashboard is disabled.' });
            return false;
        }
        if (!this.apiSecretKey || apiKey !== this.apiSecretKey) {
            res.status(HttpStatus.UNAUTHORIZED).json({
                message: 'Unauthorized. Provide valid API key via x-api-key header',
            });
            return false;
        }
        return true;
    }

    private get dashboardEnabled(): boolean {
        return (
            String(this.configService.get('ENABLE_DASHBOARD', 'true')).toLowerCase() !== 'false'
        );
    }

    private get minLiquidityUsd(): number {
        const raw = Number.parseFloat(
            this.configService.get<string>('DASHBOARD_MIN_LIQUIDITY_USD', '25000'),
        );
        return Number.isFinite(raw) ? raw : 25_000;
    }

    private get minAgeHours(): number {
        return this.num('DASHBOARD_MIN_AGE_HOURS', 24);
    }

    private get requireRugcheck(): boolean {
        return (
            String(this.configService.get('DASHBOARD_REQUIRE_RUGCHECK', 'true')).toLowerCase() !==
            'false'
        );
    }

    /**
     * Keeps only coins old enough and clean enough to plan a trade on.
     *
     * Age is checked before RugCheck because it is free and RugCheck is not: every survivor costs a
     * request through `RiskService`'s serial queue, so filtering first is the difference between a
     * few calls and twenty.
     *
     * A token RugCheck cannot answer for is dropped, not admitted. The whole point of the gate is
     * that something was checked, and letting unknowns through would make a "clean" list mean
     * "clean or unexamined" -- which is the same confusion the UNCHECKED tag exists to prevent.
     */
    private async applyMaturityFilter(
        pairs: DexScreenerPair[],
    ): Promise<{ kept: DexScreenerPair[]; tooNew: number; rejected: number; unchecked: number }> {
        const minAge = this.minAgeHours;
        const oldEnough: DexScreenerPair[] = [];
        let tooNew = 0;

        for (const p of pairs) {
            const ageHours = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3_600_000 : undefined;
            // An unknown creation time is treated as too new. DexScreener omits it mostly on pairs
            // it has barely indexed, which is exactly the case the floor is meant to exclude.
            if (ageHours === undefined || ageHours < minAge) tooNew += 1;
            else oldEnough.push(p);
        }

        if (!this.requireRugcheck) {
            return { kept: oldEnough, tooNew, rejected: 0, unchecked: 0 };
        }

        // Capped: each check is a queued request, and a list nobody scrolls past ten entries of does
        // not justify twenty of them.
        const candidates = oldEnough.slice(0, 10);
        const verdicts = await Promise.all(
            candidates.map(async (p) => ({
                pair: p,
                risk: await this.riskService.getReport(p.baseToken?.address ?? ''),
            })),
        );

        const kept: DexScreenerPair[] = [];
        let rejected = 0;
        let unchecked = 0;

        for (const { pair, risk } of verdicts) {
            if (!risk.report) {
                unchecked += 1;
                continue;
            }
            const tags = buildRiskTags({ report: risk.report });
            if (tags.some((t) => t.tone === 'DANGER')) {
                rejected += 1;
                continue;
            }
            kept.push(pair);
        }

        return { kept, tooNew, rejected, unchecked };
    }

    /** The coin list: bot candidates, the busiest tokens on the feed, or one explicit mint. */
    @Get('coins')
    async coins(
        @Headers('x-api-key') apiKey: string,
        @Query('mint') mint: string,
        @Res({ passthrough: true }) res: Response,
        @Query('source') source?: string,
    ) {
        if (!this.authorised(apiKey, res)) return undefined;

        if (mint?.trim()) {
            const pairs = await lookupPairs([mint.trim()]);
            return { source: 'manual', coins: pairs.map((p) => this.describe(p)) };
        }

        const coins: Array<ReturnType<typeof this.describe>> = [];
        const want = (source ?? 'all').toLowerCase();
        let watchlistCount = 0;

        // Bot candidates first. Production has bought nothing since 18 September, so this list can
        // be empty or stale — which is itself worth showing rather than hiding, so the reject reason
        // and the check count travel with each row.
        if (want === 'all' || want === 'bot') {
            try {
                const watchlist = await this.prismaService.watchlist.findMany({
                    where: { status: 'PENDING' },
                    orderBy: { lastCheckedAt: 'desc' },
                    take: 20,
                    select: { tokenMint: true, reason: true, checkCount: true, lastCheckedAt: true },
                });
                watchlistCount = watchlist.length;
                const byMint = new Map(watchlist.map((w) => [w.tokenMint, w]));
                const mints = watchlist.map((w) => w.tokenMint);
                if (mints.length > 0) {
                    for (const p of await lookupPairs(mints)) {
                        const row = byMint.get(p.baseToken?.address ?? '');
                        // The liquidity floor applies on the mixed list but not on the dedicated
                        // watchlist tab, because the two answer different questions. "What is worth
                        // charting" has to exclude a pool with no depth -- a band on it cannot be
                        // entered at its own price. "What is the bot watching" has to include it, or
                        // the tab hides exactly the rows whose reject reason explains the silence.
                        //
                        // Without this the mixed list was led by $0-liquidity tokens minutes old,
                        // and it disagreed with the Telegram digest, which has always applied it.
                        if (want === 'all' && (p.liquidity?.usd || 0) < this.minLiquidityUsd) {
                            continue;
                        }
                        coins.push({
                            ...this.describe(p),
                            source: 'bot',
                            botReason: row?.reason ?? undefined,
                            checkCount: row?.checkCount,
                            lastCheckedAt: row?.lastCheckedAt?.getTime(),
                        });
                    }
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.warn(`[Dashboard] Watchlist read failed: ${msg}.`);
            }
        }

        let filter: Awaited<ReturnType<typeof this.applyMaturityFilter>> | undefined;

        if (want === 'all' || want === 'feed') {
            try {
                // Twenty rather than ten from the feed, because the maturity filter is about to
                // remove most of them and a list that ends up with two entries is not a list.
                const raw = await busiestFromFeed(this.minLiquidityUsd, 20);
                filter = await this.applyMaturityFilter(raw);
                for (const p of filter.kept) {
                    if (coins.some((c) => c.mint === p.baseToken?.address)) continue;
                    coins.push({ ...this.describe(p), source: 'feed' });
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.warn(`[Dashboard] Feed read failed: ${msg}.`);
            }
        }

        // `watchlistCount` is the row count, which can exceed `coins` when DexScreener has no pair
        // for a mint yet. An empty list with a non-zero count means "the bot is watching things you
        // cannot chart", not "the bot is watching nothing".
        //
        // The filter tally travels with the answer so the page can say why a short list is short.
        // A list of three with no explanation reads as "nothing is happening", when what actually
        // happened is that seventeen candidates were examined and rejected.
        return {
            source: want,
            coins,
            watchlistCount,
            filter: filter
                ? {
                      minAgeHours: this.minAgeHours,
                      minLiquidityUsd: this.minLiquidityUsd,
                      rugcheckRequired: this.requireRugcheck,
                      tooNew: filter.tooNew,
                      rejected: filter.rejected,
                      unchecked: filter.unchecked,
                  }
                : undefined,
        };
    }

    /**
     * The heavy route: candles plus zones. Server-side cached, so a page that redraws often does
     * not translate into a fetch that often.
     */
    @Get('zones/:mint')
    async zones(
        @Param('mint') mint: string,
        @Headers('x-api-key') apiKey: string,
        @Res({ passthrough: true }) res: Response,
        @Query('tf') tf?: string,
        /**
         * Timeframe the ZONES are computed from, independent of the one the chart is drawn at.
         *
         * Separate because changing the chart timeframe was silently changing which history got
         * analysed, not just how it was drawn: the candle limit is 300 regardless, so 1m covers five
         * hours and 1h covers twelve and a half days. Levels from five hours are genuinely not levels
         * from twelve days, so the bands jumped on every timeframe change — which reads as the
         * numbers moving by themselves.
         *
         * Pinning this lets the bands be drawn once from a higher timeframe and kept still while the
         * chart zooms in to find an entry, which is how levels are normally used.
         */
        @Query('ztf') ztf?: string,
    ) {
        if (!this.authorised(apiKey, res)) return undefined;

        const requested = Number.parseInt(tf ?? '', 10);
        const result = await this.candleService.getCandles(
            mint,
            Number.isFinite(requested) ? requested : undefined,
        );
        if (result.problem) {
            return {
                mint,
                problem: result.problem,
                minimumCandles: minimumCandles(),
                candleCount: result.candles.length,
                ...this.context(
                    result.symbol,
                    result.ageHours,
                    result.liquidityUsd,
                    result.imageUrl,
                ),
            };
        }

        // A second fetch only when the zone timeframe differs, and only when it actually returns
        // something: a rate-limited zone series must fall back to the chart's own candles rather
        // than leave the page with no bands at all.
        const zoneTf = Number.parseInt(ztf ?? '', 10);
        let zoneSource = result;
        if (Number.isFinite(zoneTf) && zoneTf !== result.timeframeMinutes) {
            const higher = await this.candleService.getCandles(mint, zoneTf);
            if (!higher.problem && higher.candles.length > 0) zoneSource = higher;
        }

        const zones = computeShvedZones(zoneSource.candles, {
            fuzzFactor: this.num('SHVED_FUZZ_FACTOR', 0.75),
            fastFactor: this.num('SHVED_FAST_FACTOR', 3),
            slowFactor: this.num('SHVED_SLOW_FACTOR', 6),
        });

        const price = result.candles[result.candles.length - 1].close;
        const nearest = resolveNearestZones(zones, price);

        return {
            mint,
            candles: result.candles,
            candleCount: result.candles.length,
            minimumCandles: minimumCandles(),
            zones,
            price,
            buyZone: nearest.support
                ? { ...nearest.support, distancePct: distancePct(price, nearest.support.high) }
                : undefined,
            sellZone: nearest.resistance
                ? { ...nearest.resistance, distancePct: distancePct(price, nearest.resistance.low) }
                : undefined,
            insideZone: nearest.inside,
            timeframeMinutes: result.timeframeMinutes,
            // Which timeframe the bands came from, and how much history that covered. Both travel
            // with the answer because "levels from the last 5 hours" and "levels from the last 12
            // days" look identical on screen and mean completely different things.
            zoneTimeframeMinutes: zoneSource.timeframeMinutes,
            zoneCandleCount: zoneSource.candles.length,
            zoneHistoryHours:
                ((zoneSource.timeframeMinutes ?? 0) * zoneSource.candles.length) / 60,
            // Every buy band paired with the sell bands above it. The chart already finds more than
            // one zone a side, and showing only the nearest pair throws away the rest of the map.
            plans: buildTradePlans(zones, price),
            // Prediksi dibangun dari seri yang sama dengan pitanya, bukan dari seri chart: kalau
            // zonanya dikunci di timeframe lebih besar, momentum yang menilainya harus diukur di
            // timeframe itu juga, atau sinyalnya membandingkan dua skala yang berbeda.
            nextMove: predictNextMove({
                price,
                closes: zoneSource.candles.map((c) => c.close),
                buyZone: nearest.support,
                sellZone: nearest.resistance,
                insideZone: nearest.inside,
                candleCount: zoneSource.candles.length,
                minimumCandles: minimumCandles(),
            }),
            mintShort: mint,
            // The verdict travels with the bands rather than being rebuilt on the page, so the web
            // view and the Telegram report can never disagree about what the same chart means.
            advice: adviseOnZones({
                price,
                buyZone: nearest.support,
                sellZone: nearest.resistance,
                insideZone: nearest.inside,
                candleCount: result.candles.length,
                minimumCandles: minimumCandles(),
            }),
            ...this.context(result.symbol, result.ageHours, result.liquidityUsd, result.imageUrl),
        };
    }

    /**
     * Risk and opportunity tags for one mint.
     *
     * A route of its own rather than part of `zones`, because the two answer different questions at
     * different speeds: bands are redrawn as candles arrive, while mint authority and LP lock state
     * are facts that change rarely. Folding them together would re-ask RugCheck on every candle poll
     * to receive the same answer.
     */
    @Get('risk/:mint')
    async risk(
        @Param('mint') mint: string,
        @Headers('x-api-key') apiKey: string,
        @Res({ passthrough: true }) res: Response,
        /**
         * Reward-to-risk and the thin-history flag, carried over from the zones answer the caller
         * already holds. Passed in rather than recomputed so this route never pays for a candle
         * fetch; they only ever gate the POTENTIAL tag, and the danger tags -- the ones that matter
         * -- are derived entirely from RugCheck and from market data read here.
         */
        @Query('rr') rr?: string,
        @Query('thin') thin?: string,
    ) {
        if (!this.authorised(apiKey, res)) return undefined;

        const rewardRisk = Number.parseFloat(rr ?? '');

        const [pair, risk] = await Promise.all([
            lookupPairs([mint]).then((pairs) => pairs[0]),
            this.riskService.getReport(mint),
        ]);

        // The bot's own last verdict, when it has one. Real analyzer output, already computed and
        // free to read, and far more informative than anything this route could re-derive.
        let botReason: string | undefined;
        try {
            const row = await this.prismaService.watchlist.findFirst({
                where: { tokenMint: mint },
                orderBy: { lastCheckedAt: 'desc' },
                select: { reason: true },
            });
            botReason = row?.reason ?? undefined;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[Dashboard] Watchlist reason read failed: ${msg}.`);
        }

        const txns = pair?.txns;
        return {
            mint,
            checked: !risk.failed && Boolean(risk.report),
            riskScore: risk.report?.score_normalised,
            tags: buildRiskTags({
                report: risk.report,
                reportFailed: risk.failed,
                liquidityUsd: pair?.liquidity?.usd,
                volume24h: pair?.volume?.h24,
                volume5m: pair?.volume?.m5,
                ageHours: pair?.pairCreatedAt
                    ? (Date.now() - pair.pairCreatedAt) / 3_600_000
                    : undefined,
                buyShare1h: this.share(txns?.h1?.buys, txns?.h1?.sells),
                rewardRisk: Number.isFinite(rewardRisk) ? rewardRisk : undefined,
                thin: thin === 'true',
                botReason,
            }),
        };
    }

    /** The timeframes the chart can offer, so the page does not hardcode its own list. */
    @Get('timeframes')
    timeframes(@Headers('x-api-key') apiKey: string, @Res({ passthrough: true }) res: Response) {
        if (!this.authorised(apiKey, res)) return undefined;
        return { timeframes: CandleService.TIMEFRAMES.map((t) => t.minutes) };
    }

    /**
     * The light route: live price and the market stats around it, for the fast poll.
     *
     * Reads through `DexLimiter`, whose cache is measured in seconds, so calling this every few
     * seconds costs nothing beyond the first fetch in each window. Volume, trade counts and market
     * cap arrive in that same payload, so returning them is free — they were being fetched and then
     * discarded, which left the chart showing a price with no way to tell whether anyone was trading
     * at it. A band on a pool doing no volume is a drawing, not a level.
     */
    @Get('price/:mint')
    async price(
        @Param('mint') mint: string,
        @Headers('x-api-key') apiKey: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        if (!this.authorised(apiKey, res)) return undefined;

        const pair = (await lookupPairs([mint]))[0];
        const txns = pair?.txns;
        return {
            mint,
            priceUsd: Number.parseFloat(pair?.priceUsd || '0') || undefined,
            priceChange5m: pair?.priceChange?.m5,
            priceChange1h: pair?.priceChange?.h1,
            priceChange6h: pair?.priceChange?.h6,
            priceChange24h: pair?.priceChange?.h24,
            liquidityUsd: pair?.liquidity?.usd,
            marketCap: pair?.fdv,
            volume5m: pair?.volume?.m5,
            volume1h: pair?.volume?.h1,
            volume24h: pair?.volume?.h24,
            buys5m: txns?.m5?.buys,
            sells5m: txns?.m5?.sells,
            buys1h: txns?.h1?.buys,
            sells1h: txns?.h1?.sells,
            // The share the bot's own `MIN_H1_BUY_SHARE` gate reads, surfaced so the page shows the
            // same number the entry logic judges a token on.
            buyShare1h: this.share(txns?.h1?.buys, txns?.h1?.sells),
            buyShare5m: this.share(txns?.m5?.buys, txns?.m5?.sells),
            at: Date.now(),
        };
    }

    /** Buy share of trade count, or undefined when nothing traded — never a misleading 0. */
    private share(buys?: number, sells?: number): number | undefined {
        const total = (buys ?? 0) + (sells ?? 0);
        return total > 0 ? ((buys ?? 0) / total) * 100 : undefined;
    }

    private num(key: string, fallback: number): number {
        const raw = Number.parseFloat(this.configService.get<string>(key, String(fallback)));
        return Number.isFinite(raw) ? raw : fallback;
    }

    private context(symbol?: string, ageHours?: number, liquidityUsd?: number, imageUrl?: string) {
        // Always travels with the zones. A band drawn from a two-hour-old token looks exactly as
        // authoritative as one drawn from a week of history, and the reader has to be able to tell.
        return { symbol, ageHours, liquidityUsd, imageUrl };
    }

    private describe(p: DexScreenerPair) {
        const mint = p.baseToken?.address ?? '';
        return {
            mint,
            symbol: p.baseToken?.symbol,
            name: p.baseToken?.name,
            priceUsd: Number.parseFloat(p.priceUsd || '0') || undefined,
            liquidityUsd: p.liquidity?.usd,
            marketCap: p.fdv,
            imageUrl: p.info?.imageUrl,
            volume5m: p.volume?.m5,
            priceChange1h: p.priceChange?.h1,
            ageHours: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3_600_000 : undefined,
            metaLabel: this.metaLabelService.getLabel(mint),
            metaTier: this.metaTrendService.getHeatForMint(mint)?.tier,
            source: 'manual' as string,
            // Hanya terisi untuk baris dari watchlist; feed tidak punya penilaian bot.
            botReason: undefined as string | undefined,
            checkCount: undefined as number | undefined,
            lastCheckedAt: undefined as number | undefined,
        };
    }

}
