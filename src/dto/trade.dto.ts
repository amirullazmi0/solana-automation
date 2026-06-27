import { TradeRoute } from '@prisma/client';

export type TradeAuditFields = {
    solPriceAtEntry?: number | null;
    entryValueUsd?: number | null;
    totalFeesSol?: number | null;
};

export type BuyRiskMetrics = {
    dailyRealizedPnlUsd: number;
    consecutiveLosses: number;
    totalRealizedPnlUsd: number;
};

export type BuyRiskConfig = {
    disabledUntilMs: number | null;
    dailyMaxLossUsd: number;
    maxConsecutiveLosses: number;
    maxDrawdownPct: number;
};

export type BuyExecutionOptions = {
    customSlippageBps?: number;
    priorityFeeSol?: number;
    targetTakeProfit?: number;
    targetStopLoss?: number;
    targetTrailingDistance?: number;
    route?: TradeRoute;
    positionSizeMultiplier?: number;
    aiDecisionSnapshotId?: number;
};
