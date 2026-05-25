import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface AIAnalysisResult {
    cuanConvictionScore: number;
    predictedPumpPercentage: number;
    confidenceLevel: 'high' | 'medium' | 'low';
    reasoning: string;
    action: 'buy' | 'skip';
}

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

    async analyzeToken(
        tokenMint: string,
        symbol: string,
        metrics: {
            ageHours: number;
            liquidityUsd: number;
            marketCapUsd: number;
            volume5mUsd: number;
            buys5mCount: number;
            sells5mCount: number;
            priceChange1hPct: number;
            isPumpFun: boolean;
            rugcheckScore?: number;
            dangerRisksCount?: number;
            creatorHoldPct?: number;
        },
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

        this.logger.log(
            `🧠 Calling AI Model (${model}) to analyze token $${symbol} (${tokenMint})...`,
        );

        try {
            const systemPrompt = `You are an expert Solana on-chain analyst and quantitative memecoin trader. Your job is to evaluate if a token is highly likely to pump ("cuan") or if it is a rug/scam/dump.
Analyze the provided metrics and return a JSON object with the following fields:
{
  "cuanConvictionScore": <number between 0 and 100 representing your conviction level>,
  "predictedPumpPercentage": <estimated percentage pump potential, e.g. 20, 50, 150>,
  "confidenceLevel": "high" | "medium" | "low",
  "reasoning": "<brief indonesian explanation of why it is cuan or skip, max 2 sentences>",
  "action": "buy" | "skip"
}
Rules:
1. "action" must only be "buy" if "cuanConvictionScore" is >= 75. Otherwise, "action" must be "skip".
2. If liquidity is low (< $3000) or RugCheck danger risks are high, conviction must be very low.
3. Be highly objective. Most memecoins are scams. Only rate high if volume, buy/sell ratio, and support consolidation look solid.
4. Output MUST be a valid JSON object matching the schema. Do not output markdown wrappers.`;

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

Please evaluate.`;

            const response = await axios.post(
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

            const content = response.data?.choices?.[0]?.message?.content;
            if (!content) {
                throw new Error('Empty response from AI completions');
            }

            const parsed = JSON.parse(content) as AIAnalysisResult;

            // Validate output types to avoid typescript runtime surprises
            const result: AIAnalysisResult = {
                cuanConvictionScore: Number(parsed.cuanConvictionScore) || 0,
                predictedPumpPercentage: Number(parsed.predictedPumpPercentage) || 0,
                confidenceLevel: ['high', 'medium', 'low'].includes(parsed.confidenceLevel)
                    ? parsed.confidenceLevel
                    : 'low',
                reasoning: parsed.reasoning || 'No reasoning provided.',
                action: ['buy', 'skip'].includes(parsed.action) ? parsed.action : 'skip',
            };

            // Double check rule 1 constraint
            if (result.cuanConvictionScore < 75) {
                result.action = 'skip';
            }

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
