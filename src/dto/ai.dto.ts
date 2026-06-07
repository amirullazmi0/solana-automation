export interface AIAnalysisMetrics {
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
}

export interface AIAnalysisResult {
    cuanConvictionScore: number;
    predictedPumpPercentage: number;
    confidenceLevel: 'high' | 'medium' | 'low';
    reasoning: string;
    action: 'buy' | 'skip';
}

export interface AIThresholdSnapshot {
    botMode: string;
    dryRun: boolean;
    aiConvictionThreshold: number;
    minLiquidityUsd: number;
    minVolumeUsd: number;
    minBuyCount: number;
    minMarketCapUsd: number;
    maxMarketCapUsd: number;
    minAgeHours: number;
    maxAgeHours: number;
    minBuyConfidence: number;
    minVolumeMarketCapRatio: number;
    minVolumeLiquidityRatio: number;
    minVolScore: number;
    minZScore: number;
    minVolumeSurge: number;
    rugcheckMinSafetyIndex: number;
    maxRugcheckScore: number;
    takeProfitPercent: number;
    stopLossPercent: number;
    trailingDistancePercent: number;
    hardCrashPercent: number;
    slPatienceEnabled: boolean;
    totalCapitalUsd: number;
    reserveAmountUsd: number;
    positionSizeUsd: number;
    totalSlots: number;
    slippageBps: number;
    maxPriceImpactPercent: number;
    cooldownWinHours: number;
    cooldownLossHours: number;
}

export interface OpenAIChatChoiceMessage {
    content?: string;
}

export interface OpenAIChatChoice {
    message?: OpenAIChatChoiceMessage;
}

export interface OpenAIChatCompletionResponse {
    choices?: OpenAIChatChoice[];
}

