import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import {
    AIAnalysisMetrics,
    AIAnalysisResult,
    AIThresholdSnapshot,
    OpenAIChatCompletionResponse,
} from '../dto/ai.dto';

interface CacheEntry {
    result: AIAnalysisResult;
    expiresAt: number;
}

@Injectable()
export class AIService {
    private readonly logger = new Logger(AIService.name);
    private readonly cache = new Map<string, CacheEntry>();
    private readonly cacheTTLMs = 10 * 60 * 1000;

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
    ) {}

    private getNumberConfig(key: string, fallback: number): number {
        const value = Number.parseFloat(this.configService.get<string>(key, String(fallback)));
        return Number.isFinite(value) ? value : fallback;
    }

    private getIntegerConfig(key: string, fallback: number): number {
        const value = Number.parseInt(this.configService.get<string>(key, String(fallback)), 10);
        return Number.isFinite(value) ? value : fallback;
    }

    private getTrailingDistanceConfig(): number {
        return this.getNumberConfig('TRAILING_DISTANCE_PERCENT', 5);
    }

    private getMarketRegimeConfig(): string {
        const value = this.configService.get<string>('MARKET_REGIME', 'balanced');
        return value && value.trim().length > 0 ? value.trim() : 'balanced';
    }

    private calculateRatio(numerator: number, denominator: number): number {
        try {
            if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
                return 0;
            }
            return numerator / denominator;
        } catch {
            return 0;
        }
    }

    private calculateBuyConfidence(metrics: AIAnalysisMetrics): number {
        try {
            const totalTx = metrics.buys5mCount + metrics.sells5mCount;
            if (totalTx <= 0) return 0;
            return metrics.buys5mCount / totalTx;
        } catch {
            return 0;
        }
    }

    private formatAgeDisplay(ageHours: number): string {
        try {
            if (!Number.isFinite(ageHours) || ageHours < 0) {
                return 'Unknown';
            }
            if (ageHours < 1) {
                const ageMinutes = ageHours * 60;
                return `${ageMinutes.toFixed(1)} minutes`;
            }
            return `${ageHours.toFixed(2)} hours`;
        } catch {
            return 'Unknown';
        }
    }

    private getSafeRugcheckScore(score?: number): number {
        if (!Number.isFinite(score ?? Number.NaN)) {
            return 0;
        }
        return score ?? 0;
    }

    private resolveRoute(metrics: AIAnalysisMetrics): 'MICIN' | 'WHALE' {
        return metrics.route ?? (metrics.ageHours >= 2 ? 'WHALE' : 'MICIN');
    }

    private formatRouteLabel(route: 'MICIN' | 'WHALE'): 'MICIN_ROUTE' | 'WHALE_ROUTE' {
        return route === 'WHALE' ? 'WHALE_ROUTE' : 'MICIN_ROUTE';
    }

    private async saveDecisionSnapshot(
        tokenMint: string,
        route: 'MICIN' | 'WHALE',
        metrics: AIAnalysisMetrics,
        result: AIAnalysisResult,
    ): Promise<number | undefined> {
        try {
            const snapshot = await this.prismaService.aiDecisionSnapshot.create({
                data: {
                    tokenMint,
                    route,
                    metrics: metrics as unknown as object,
                    result: {
                        cuanConvictionScore: result.cuanConvictionScore,
                        predictedPumpPercentage: result.predictedPumpPercentage,
                        confidenceLevel: result.confidenceLevel,
                        reasoning: result.reasoning,
                        action: result.action,
                        positionSizeMultiplier: result.positionSizeMultiplier,
                        customTrailingBaseDistance: result.customTrailingBaseDistance,
                    },
                },
            });
            return snapshot.id;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[AI TRACE] Failed to save decision snapshot for ${tokenMint}: ${msg}`);
            return undefined;
        }
    }

    private sanitizePositionSizeMultiplier(value?: number): number {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
            return 1;
        }
        return Math.min(Math.max(numericValue, 0.1), 1);
    }

    private sanitizeTrailingBaseDistance(value?: number): number {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue) || numericValue <= 0) {
            return this.getTrailingDistanceConfig();
        }
        return numericValue;
    }

    public getRecommendedTrailingDistance(volScore: number, priceChange1h: number): number {
        try {
            const defaultTrailingDistance = this.getTrailingDistanceConfig();
            if (!Number.isFinite(volScore) || !Number.isFinite(priceChange1h)) {
                return defaultTrailingDistance;
            }

            const chaosDetected = volScore > 0.8 || Math.abs(priceChange1h) > 50;
            if (!chaosDetected) {
                return defaultTrailingDistance;
            }

            const severeChaos = volScore > 1.2 || Math.abs(priceChange1h) > 100;
            return severeChaos ? 2.5 : 3.0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `[AI Brain] Trailing distance recommendation failed, using default config: ${message}`,
            );
            return this.getTrailingDistanceConfig();
        }
    }

    private normalizeAnalysisResult(
        parsed: Partial<AIAnalysisResult>,
        thresholds: AIThresholdSnapshot,
    ): AIAnalysisResult {
        const score = Number(parsed.cuanConvictionScore);
        const predictedPump = Number(parsed.predictedPumpPercentage);
        const confidenceLevel = ['high', 'medium', 'low'].includes(
            parsed.confidenceLevel || '',
        )
            ? (parsed.confidenceLevel as AIAnalysisResult['confidenceLevel'])
            : 'low';
        const action = parsed.action === 'buy' || parsed.action === 'skip' ? parsed.action : 'skip';

        const result: AIAnalysisResult = {
            cuanConvictionScore: Number.isFinite(score) ? Math.min(Math.max(score, 0), 100) : 0,
            predictedPumpPercentage: Number.isFinite(predictedPump) ? Math.max(predictedPump, 0) : 0,
            confidenceLevel,
            reasoning:
                typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0
                    ? parsed.reasoning.trim().slice(0, 500)
                    : 'No reasoning provided.',
            action,
            positionSizeMultiplier: this.sanitizePositionSizeMultiplier(parsed.positionSizeMultiplier),
            customTrailingBaseDistance: this.sanitizeTrailingBaseDistance(
                parsed.customTrailingBaseDistance,
            ),
        };

        if (result.cuanConvictionScore < thresholds.aiConvictionThreshold) {
            result.action = 'skip';
        }

        return result;
    }

    private getThresholdSnapshot(): AIThresholdSnapshot {
        const disableSlPatience =
            this.configService.get<string>('DISABLE_SL_PATIENCE', 'false') === 'true';

        return {
            botMode: 'hybrid',
            aiConvictionThreshold: this.getNumberConfig('AI_CONVICTION_THRESHOLD', 75),
            minLiquidityUsd: this.getNumberConfig('MIN_LIQUIDITY_USD', 7500),
            minVolumeUsd: this.getNumberConfig('MIN_VOLUME_USD', 500),
            minBuyCount: this.getIntegerConfig('MIN_BUY_COUNT', 5),
            minMarketCapUsd: this.getNumberConfig('MIN_MCAP', 5000),
            maxMarketCapUsd: this.getNumberConfig('MAX_MCAP', 300000),
            minAgeHours: this.getNumberConfig('MIN_AGE_HOURS', 0.02),
            maxAgeHours: this.getNumberConfig('MAX_AGE_HOURS', 24),
            minBuyConfidence: this.getNumberConfig('MIN_BUY_CONFIDENCE', 0.6),
            minVolumeMarketCapRatio: this.getNumberConfig('MIN_VOLUME_MCAP_RATIO', 0.05),
            minVolumeLiquidityRatio: this.getNumberConfig('MIN_VL_RATIO', 0),
            minVolScore: this.getNumberConfig('ANALYZER_MIN_VOL_SCORE', 0.02),
            minZScore: this.getNumberConfig('ANALYZER_MIN_Z_SCORE', 1.5),
            minVolumeSurge: this.getNumberConfig('ANALYZER_MIN_VOLUME_SURGE', 1.5),
            rugcheckMinSafetyIndex: this.getNumberConfig('RUGCHECK_MIN_SAFETY_INDEX', 0.8),
            maxRugcheckScore: 1000,
            takeProfitPercent: this.getNumberConfig('TAKE_PROFIT_PERCENT', 30),
            stopLossPercent: this.getNumberConfig('STOP_LOSS_PERCENT', 25),
            trailingDistancePercent: this.getNumberConfig('TRAILING_DISTANCE_PERCENT', 5),
            hardCrashPercent: 55,
            slPatienceEnabled: !disableSlPatience,
            totalCapitalUsd: this.getNumberConfig('TOTAL_CAPITAL', 20),
            reserveAmountUsd: this.getNumberConfig('RESERVE_AMOUNT', 8),
            positionSizeUsd: this.getNumberConfig('POSITION_SIZE_USD', 3),
            totalSlots: this.getIntegerConfig('TOTAL_SLOTS', 4),
            slippageBps: this.getIntegerConfig('SLIPPAGE_BPS', 100),
            maxPriceImpactPercent: this.getNumberConfig('MAX_PRICE_IMPACT_PCT', 15),
            cooldownWinHours: this.getNumberConfig('COOLDOWN_WIN_HOURS', 6),
            cooldownLossHours: this.getNumberConfig('COOLDOWN_LOSS_HOURS', 24),
            marketRegime: this.getMarketRegimeConfig(),
        };
    }

    async analyzeToken(
        tokenMint: string,
        symbol: string,
        metrics: AIAnalysisMetrics,
    ): Promise<AIAnalysisResult> {
        const route = this.resolveRoute(metrics);
        const routeLabel = this.formatRouteLabel(route);
        const cached = this.cache.get(tokenMint);
        if (cached && cached.expiresAt > Date.now()) {
            this.logger.debug(`[${tokenMint}] Serving AI analysis from cache.`);
            const aiDecisionSnapshotId = await this.saveDecisionSnapshot(
                tokenMint,
                route,
                metrics,
                cached.result,
            );
            return { ...cached.result, aiDecisionSnapshotId };
        }

        const apiKey = this.configService.get<string>('OPENAI_API_KEY');
        if (!apiKey) {
            this.logger.warn('OPENAI_API_KEY is not configured. Defaulting to SKIP.');
            return {
                cuanConvictionScore: 0,
                predictedPumpPercentage: 0,
                confidenceLevel: 'low',
                reasoning: 'API Key OpenAI belum dikonfigurasi.',
                action: 'skip',
                positionSizeMultiplier: 1,
                customTrailingBaseDistance: this.getTrailingDistanceConfig(),
            };
        }

        const baseUrl = this.configService.get<string>('AI_BASE_URL', 'https://api.openai.com/v1');
        const model = this.configService.get<string>('AI_MODEL', 'gpt-4o-mini');
        const thresholds = this.getThresholdSnapshot();

        this.logger.log(`🧠 Calling AI Model (${model}) to analyze token $${symbol} (${tokenMint})...`);

        try {
            const systemPrompt = `You are MaSoul Sniper's AI Conviction Engine, an expert Solana on-chain analyst and quantitative memecoin trader.
You are the final judge. The deterministic NestJS filters already ran before this call. Your job is the final sanity-check and conviction score using the live runtime thresholds below.

Return a JSON object with exactly these fields:
{
  "cuanConvictionScore": <number between 0 and 100 representing your conviction level>,
  "predictedPumpPercentage": <estimated percentage pump potential, e.g. 20, 50, 150>,
  "confidenceLevel": "high" | "medium" | "low",
  "reasoning": "<brief indonesian explanation of why it is cuan or skip, max 2 sentences>",
  "action": "buy" | "skip",
  "positionSizeMultiplier": <number between 0.1 and 1.0 based on asset short-term risks vs velocity>,
  "customTrailingBaseDistance": <number, optional custom recommended base trailing distance percent>
}
	Live runtime thresholds and route context:
	- PIPELINE_MODE=${thresholds.botMode}
	- ROUTE=${routeLabel}
	- MARKET_REGIME=${thresholds.marketRegime}
	- AI_CONVICTION_THRESHOLD=${thresholds.aiConvictionThreshold}
	- MIN_LIQUIDITY_USD=${thresholds.minLiquidityUsd}
	- MIN_VOLUME_USD=${thresholds.minVolumeUsd}
	- MIN_BUY_COUNT=${thresholds.minBuyCount}
	- MIN_MCAP=${thresholds.minMarketCapUsd}
	- MAX_MCAP=${thresholds.maxMarketCapUsd}
	- MIN_AGE_HOURS=${thresholds.minAgeHours}
	- MAX_AGE_HOURS=${thresholds.maxAgeHours}
	- MIN_BUY_CONFIDENCE=${thresholds.minBuyConfidence}
	- MIN_VOLUME_MCAP_RATIO=${thresholds.minVolumeMarketCapRatio}
	- MIN_VL_RATIO=${thresholds.minVolumeLiquidityRatio}
	- ANALYZER_MIN_VOL_SCORE=${thresholds.minVolScore}
	- ANALYZER_MIN_Z_SCORE=${thresholds.minZScore}
	- ANALYZER_MIN_VOLUME_SURGE=${thresholds.minVolumeSurge}
	- RUGCHECK_MIN_SAFETY_INDEX=${thresholds.rugcheckMinSafetyIndex}
	- MAX_RUGCHECK_SCORE=${thresholds.maxRugcheckScore}
	- TAKE_PROFIT_PERCENT=${thresholds.takeProfitPercent}
	- STOP_LOSS_PERCENT=${thresholds.stopLossPercent}
	- TRAILING_DISTANCE_PERCENT=${thresholds.trailingDistancePercent}
	- HARD_CRASH_PERCENT=${thresholds.hardCrashPercent}
	- SL_PATIENCE_ENABLED=${thresholds.slPatienceEnabled}
	- TOTAL_CAPITAL=${thresholds.totalCapitalUsd}
	- RESERVE_AMOUNT=${thresholds.reserveAmountUsd}
	- POSITION_SIZE_USD=${thresholds.positionSizeUsd}
	- TOTAL_SLOTS=${thresholds.totalSlots}
	- SLIPPAGE_BPS=${thresholds.slippageBps}
	- MAX_PRICE_IMPACT_PCT=${thresholds.maxPriceImpactPercent}
	- COOLDOWN_WIN_HOURS=${thresholds.cooldownWinHours}
	- COOLDOWN_LOSS_HOURS=${thresholds.cooldownLossHours}

	Decision rules:
	1. "action" must only be "buy" if "cuanConvictionScore" is >= AI_CONVICTION_THRESHOLD. Otherwise use "skip".
	2. Matrix Velocity Rules: Carefully evaluate short-term momentum changes (5m and 15m price changes). If 5m price pump is excessively vertical compared to 15m/1h, penalize positionSizeMultiplier to protect capital from malicious bot pumps.
	3. Creator Profile Rules: Heavily penalize or enforce an absolute "skip" if the creator has a high historical "rugged tokens" count or if the "creator risk score" is critical.
	4. If MARKET_REGIME is bearish_chaos, be extremely conservative, restrict scores, and penalize volatile assets by reducing positionSizeMultiplier (0.1 to 0.5).
	5. If MARKET_REGIME is bullish_gas, you may be more permissive to high-momentum tokens, but still respect risk baselines.
	6. Narrative & Social Rubric: For ROUTE=WHALE_ROUTE, or any token older than 2 hours, prefer a credible social footprint. If Telegram and Twitter are both missing, treat it as a major red flag and penalize the conviction score because the token likely lacks community foundation. If only one of Twitter/Telegram exists, apply a smaller penalty and rely more on on-chain confirmation before returning BUY. Reward signs of Community Takeover (CTO), but do not overrule obvious risk signals.
	7. Meta Awareness: Use Token Name to infer the current narrative/meta (e.g. AI, Cat, Dog, Politics, Celebrity, Meme, Solana-native). If the name aligns with a high-momentum crypto trend and the token also has active socials, slightly boost conviction. If the name is generic or socially silent, do not invent narrative strength.
	8. Social quality matters more than raw quantity in whale route: website alone is not enough; Twitter and Telegram are the strongest community signals, but a single credible social plus strong on-chain confirmation can still be acceptable. Treat website as a bonus.
	9. Deterministic Whale Signal Score: Treat the supplied Whale Signal Score as the anchor pre-filter. High score means the token has stronger community, narrative, and resilience signals; low score means the model should avoid overrating noisy pumps.
	10. Micin Anti-Noisy Rule: When the route is MICIN_ROUTE and the data shows a vertical 5m spike that is unsupported by 15m/1h, weak VoL/Z-score, or obvious sell pressure, strongly prefer "skip" unless there is exceptional on-chain confirmation.
	11. If Whale Signal Score is negative, treat the token as highly suspicious unless the rest of the data is overwhelmingly bullish.
	12. Be highly objective. Output only valid JSON; no markdown wrappers.`;

            const ageDisplay = this.formatAgeDisplay(metrics.ageHours);
            const safeRugcheckScore = this.getSafeRugcheckScore(metrics.rugcheckScore);
            const tokenName = metrics.tokenName ?? 'Unknown';
            const whaleSignalScore =
                typeof metrics.whaleSignalScore === 'number'
                    ? metrics.whaleSignalScore.toFixed(0)
                    : 'Unknown';
            const socialStatus = {
                website: metrics.hasWebsite ? 'Verified' : 'Missing',
                twitter: metrics.hasTwitter ? 'Verified' : 'Missing',
                telegram: metrics.hasTelegram ? 'Verified' : 'Missing',
                dexPaidUpdated:
                    metrics.isDexPaidUpdated === undefined
                        ? 'Unknown'
                        : metrics.isDexPaidUpdated
                          ? 'Yes'
                          : 'No',
                communityTakeover:
                    metrics.isCommunityTakeover === undefined
                        ? 'Unknown'
                        : metrics.isCommunityTakeover
                          ? 'Yes'
                          : 'No',
            };

            const userPrompt = `Token Symbol: $${symbol}
Mint Address: ${tokenMint}
Route: ${routeLabel}
- Social & Narrative Profile:
	- Token Name: ${tokenName}
	- Website: ${socialStatus.website}
	- Twitter: ${socialStatus.twitter}
	- Telegram: ${socialStatus.telegram}
	- Dex Paid Updated: ${socialStatus.dexPaidUpdated}
	- Community Takeover: ${socialStatus.communityTakeover}
	- Whale Signal Score: ${whaleSignalScore}
Token Metrics:
- Age: ${ageDisplay}
- Liquidity: $${metrics.liquidityUsd.toLocaleString()}
- Market Cap: $${metrics.marketCapUsd.toLocaleString()}
- 5m Volume: $${metrics.volume5mUsd.toLocaleString()}
- 5m Buys: ${metrics.buys5mCount}
- 5m Sells: ${metrics.sells5mCount}
- 1m/5m/15m/1h Velocity Structure:
  * 5m Price Change: ${metrics.priceChange5mPct !== undefined ? `${metrics.priceChange5mPct.toFixed(2)}%` : 'Unknown'}
  * 15m Price Change: ${metrics.priceChange15mPct !== undefined ? `${metrics.priceChange15mPct.toFixed(2)}%` : 'Unknown'}
  * 1h Price Change: ${metrics.priceChange1hPct.toFixed(2)}%
- Is Pump.fun Migration: ${metrics.isPumpFun ? 'Yes' : 'No'}
- RugCheck Score: ${safeRugcheckScore}
- Danger Risks Count: ${metrics.dangerRisksCount ?? 0}
- Creator Database Profile:
  * Tokens Created by Dev: ${metrics.creatorTokensCreated ?? 0}
  * Known Rugged Tokens by Dev: ${metrics.creatorRuggedTokens ?? 0}
  * Developer Structural Risk Score: ${metrics.creatorRiskScore !== undefined ? `${metrics.creatorRiskScore}/100` : 'Unknown'}
- Creator Holding: ${metrics.creatorHoldPct !== undefined ? `${metrics.creatorHoldPct.toFixed(2)}%` : 'Unknown'}
- Top 10 Holder Concentration: ${metrics.top10HolderPct !== undefined ? `${metrics.top10HolderPct.toFixed(2)}%` : 'Unknown'}
- Safety Index: ${metrics.safetyIndex !== undefined ? metrics.safetyIndex.toFixed(4) : 'Unknown'}
- Volume Surge: ${metrics.volumeSurge !== undefined ? `${metrics.volumeSurge.toFixed(2)}x` : 'Unknown'}
- VoL Score: ${metrics.volScore !== undefined ? metrics.volScore.toFixed(4) : 'Unknown'}
- Volume Z-Score: ${metrics.zScore !== undefined ? metrics.zScore.toFixed(2) : 'Unknown'}
- Derived Buy Confidence: ${this.calculateBuyConfidence(metrics).toFixed(4)}
- Derived Volume/MCap Ratio: ${this.calculateRatio(metrics.volume5mUsd, metrics.marketCapUsd).toFixed(4)}
- Derived Volume/Liquidity Ratio: ${this.calculateRatio(metrics.volume5mUsd, metrics.liquidityUsd).toFixed(4)}

Evaluate against the live thresholds above and return the JSON decision.`;

            const response = await axios.post<OpenAIChatCompletionResponse>(
                `${baseUrl}/chat/completions`,
                {
                    model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    response_format: { type: 'json_object' },
                    temperature: 0.2,
                },
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 10000,
                },
            );

            const content = response.data.choices?.[0]?.message?.content;
            if (!content) {
                throw new Error('Empty response from AI completions');
            }

            const parsed = JSON.parse(content) as Partial<AIAnalysisResult>;
            const result = this.normalizeAnalysisResult(parsed, thresholds);
            result.aiDecisionSnapshotId = await this.saveDecisionSnapshot(
                tokenMint,
                route,
                metrics,
                result,
            );

            this.cache.set(tokenMint, {
                result: { ...result, aiDecisionSnapshotId: undefined },
                expiresAt: Date.now() + this.cacheTTLMs,
            });

            const mappedPositionSize = thresholds.positionSizeUsd * result.positionSizeMultiplier;
            this.logger.log(
                [
                    `[AI TRACE DECISION] Token: $${symbol} | Mint: ${tokenMint.slice(0, 6)}...${tokenMint.slice(-4)} (PUMP.FUN: ${metrics.isPumpFun ? 'YES' : 'NO'})`,
                    `Route Context: ${routeLabel}`,
                    `Macro Regime Context: ${thresholds.marketRegime.toUpperCase()}`,
                    `Matrix Price Velocity: 5m(${(metrics.priceChange5mPct ?? 0).toFixed(2)}%) | 15m(${(metrics.priceChange15mPct ?? 0).toFixed(2)}%) | 1h(${metrics.priceChange1hPct.toFixed(2)}%)`,
                    `Whale Signal Score: ${metrics.whaleSignalScore ?? 0}/100`,
                    `Creator Wallet Audit: Created: ${metrics.creatorTokensCreated ?? 0} | Rugs: ${metrics.creatorRuggedTokens ?? 0} | Risk: ${metrics.creatorRiskScore ?? 0}/100`,
                    `Conviction Engine Check: Verdict Score: ${result.cuanConvictionScore}/100 -> ACTION: ${result.action.toUpperCase()}`,
                    `Strategic Dynamic Sizing: Sizing Multiplier: ${result.positionSizeMultiplier}x (Allocated: ${mappedPositionSize.toFixed(2)}) | Custom Trailing: ${result.customTrailingBaseDistance ?? thresholds.trailingDistancePercent}%`,
                    `[Reasoning]: ${result.reasoning}`,
                ].join('\n'),
            );
            return result;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`AI analysis call failed: ${msg}`);
            const fallbackResult: AIAnalysisResult = {
                cuanConvictionScore: 0,
                predictedPumpPercentage: 0,
                confidenceLevel: 'low',
                reasoning: `AI analysis failed: ${msg}`,
                action: 'skip',
                positionSizeMultiplier: 1,
                customTrailingBaseDistance: this.getTrailingDistanceConfig(),
            };
            fallbackResult.aiDecisionSnapshotId = await this.saveDecisionSnapshot(
                tokenMint,
                route,
                metrics,
                fallbackResult,
            );
            return fallbackResult;
        }
    }
}




