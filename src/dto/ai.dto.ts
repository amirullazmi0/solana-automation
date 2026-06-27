export interface AIAnalysisMetrics {
    ageHours: number;
    liquidityUsd: number;
    marketCapUsd: number;
    volume5mUsd: number;
    buys5mCount: number;
    sells5mCount: number;
    priceChange1hPct: number;
    isPumpFun: boolean;
    hasWebsite: boolean;
    hasTwitter: boolean;
    hasTelegram: boolean;
    isDexPaidUpdated?: boolean;
    isCommunityTakeover?: boolean;
    tokenName?: string;
    whaleSignalScore?: number;
    rugcheckScore?: number;
    dangerRisksCount?: number;
    creatorHoldPct?: number;
    top10HolderPct?: number;
    safetyIndex?: number;
    volumeSurge?: number;
    volScore?: number;
    zScore?: number;
    priceChange5mPct?: number;
    priceChange15mPct?: number;
    creatorTokensCreated?: number;
    creatorRuggedTokens?: number;
    creatorRiskScore?: number;
    route?: 'MICIN' | 'WHALE';
}

export interface AIAnalysisResult {
    cuanConvictionScore: number;
    predictedPumpPercentage: number;
    confidenceLevel: 'high' | 'medium' | 'low';
    reasoning: string;
    action: 'buy' | 'skip';
    positionSizeMultiplier: number;
    customTrailingBaseDistance?: number;
    aiDecisionSnapshotId?: number;
}

export interface AIHealthCheckMetrics extends AIAnalysisMetrics {
    currentProfitPercent: number;
    stopLossPercent: number;
}

export interface AIHealthCheckResult {
    status: 'HEALTHY' | 'CRITICAL';
    confidenceLevel: 'high' | 'medium' | 'low';
    reasoning: string;
    reentrySignal: boolean;
}

export interface AIThresholdSnapshot {    botMode: string;
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
    marketRegime: string;
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
