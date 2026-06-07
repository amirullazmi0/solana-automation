import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
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
    private readonly cacheTTLMs = 10 * 60 * 1000; // 10 minutes cache

    constructor(private readonly configService: ConfigService) {}

    private getNumberConfig(key: string, fallback: number): number {
        const value = Number.parseFloat(this.configService.get<string>(key, String(fallback)));
        return Number.isFinite(value) ? value : fallback;
    }

    private getIntegerConfig(key: string, fallback: number): number {
        const value = Number.parseInt(this.configService.get<string>(key, String(fallback)), 10);
        return Number.isFinite(value) ? value : fallback;
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
            cuanConvictionScore: Number.isFinite(score)
                ? Math.min(Math.max(score, 0), 100)
                : 0,
            predictedPumpPercentage: Number.isFinite(predictedPump)
                ? Math.max(predictedPump, 0)
                : 0,
            confidenceLevel,
            reasoning:
                typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0
                    ? parsed.reasoning.trim().slice(0, 500)
                    : 'No reasoning provided.',
            action,
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
            botMode: this.configService.get<string>('BOT_MODE', 'micin'),
            dryRun: this.configService.get<string>('DRY_RUN', 'true') === 'true',
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
        };
    }

    async analyzeToken(
        tokenMint: string,
        symbol: string,
        metrics: AIAnalysisMetrics,
    ): Promise<AIAnalysisResult> {
        // 1. Check cache
        const cached = this.cache.get(tokenMint);
        if (cached && cached.expiresAt > Date.now()) {
            this.logger.debug(`[${tokenMint}] Serving AI analysis from cache.`);
            return cached.result;
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
            };
        }

        const baseUrl = this.configService.get<string>('AI_BASE_URL', 'https://api.openai.com/v1');
        const model = this.configService.get<string>('AI_MODEL', 'gpt-4o-mini');
        const thresholds = this.getThresholdSnapshot();

        this.logger.log(
            `🧠 Calling AI Model (${model}) to analyze token $${symbol} (${tokenMint})...`,
        );

        try {
            const systemPrompt = `You are MaSoul Sniper's AI Conviction Engine, an expert Solana on-chain analyst and quantitative memecoin trader.
You are NOT the primary filter. The deterministic NestJS filters already ran before this call. Your job is the final sanity-check and conviction score using the live .env thresholds below.

Return a JSON object with exactly these fields:
{
  "cuanConvictionScore": <number between 0 and 100 representing your conviction level>,
  "predictedPumpPercentage": <estimated percentage pump potential, e.g. 20, 50, 150>,
  "confidenceLevel": "high" | "medium" | "low",
  "reasoning": "<brief indonesian explanation of why it is cuan or skip, max 2 sentences>",
  "action": "buy" | "skip"
}
Live .env thresholds and mode:
- BOT_MODE=${thresholds.botMode}
- DRY_RUN=${thresholds.dryRun}
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
2. If liquidity, volume, buy count, market cap, age, or buy confidence are below the live thresholds, strongly penalize conviction even if momentum looks attractive.
3. If RugCheck score is above ${thresholds.maxRugcheckScore}, danger risks count is above 0, or creator holding is above 5%, conviction must be very low.
4. For DRY_RUN=true, still judge as if this were a real trade. Do not become more permissive because it is simulation mode.
5. Prefer "buy" only when volume, buyer dominance, liquidity, market cap, age, and risk profile are all coherent with BOT_MODE=${thresholds.botMode}.
6. Be highly objective. Most memecoins are scams. Output only valid JSON; no markdown wrappers.`;

            const userPrompt = `Token Symbol: $${symbol}
Mint Address: ${tokenMint}
Token Metrics:
- Age: ${metrics.ageHours.toFixed(2)} hours
- Liquidity: $${metrics.liquidityUsd.toLocaleString()}
- Market Cap: $${metrics.marketCapUsd.toLocaleString()}
- 5m Volume: $${metrics.volume5mUsd.toLocaleString()}
- 5m Buys: ${metrics.buys5mCount}
- 5m Sells: ${metrics.sells5mCount}
- 1h Price Change: ${metrics.priceChange1hPct.toFixed(2)}%
- Is Pump.fun Migration: ${metrics.isPumpFun ? 'Yes' : 'No'}
- RugCheck Score: ${metrics.rugcheckScore ?? 'Unknown'}
- Danger Risks Count: ${metrics.dangerRisksCount ?? 0}
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
                    timeout: 10000, // 10s timeout
                },
            );

            const content = response.data.choices?.[0]?.message?.content;
            if (!content) {
                throw new Error('Empty response from AI completions');
            }

            const parsed = JSON.parse(content) as Partial<AIAnalysisResult>;
            const result = this.normalizeAnalysisResult(parsed, thresholds);

            // Save to cache
            this.cache.set(tokenMint, {
                result,
                expiresAt: Date.now() + this.cacheTTLMs,
            });

            this.logger.log(
                `🧠 AI Decision for $${symbol}: Score=${result.cuanConvictionScore}, Action=${result.action.toUpperCase()}, Pred=${result.predictedPumpPercentage}%`,
            );
            return result;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`AI analysis call failed: ${msg}`);
            return {
                cuanConvictionScore: 0,
                predictedPumpPercentage: 0,
                confidenceLevel: 'low',
                reasoning: `AI analysis failed: ${msg}`,
                action: 'skip',
            };
        }
    }
}
