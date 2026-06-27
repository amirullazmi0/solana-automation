export type WatchlistTelegramStatus = 'WAITING' | 'REJECTED' | 'BLOCKED';
export type WatchlistTelegramSeverity = 'soft_fail' | 'hard_fail' | 'unknown';

export interface WatchlistStatusUpdateParams {
    tokenMint: string;
    symbol?: string;
    route?: string;
    reason?: string;
    permanent?: boolean;
    mcap?: number;
    liquidity?: number;
    ageHours?: number;
    volumeSurge?: number;
    volScore?: number;
    zScore?: number;
    whaleSignalScore?: number;
    retryCount?: number;
    maxRetries?: number;
}

export interface WatchlistReasonMapping {
    status: WatchlistTelegramStatus;
    label: string;
    severity: WatchlistTelegramSeverity;
    message: string;
    action: string;
}

export type TradeFailureStage = 'PRE_SWAP' | 'QUOTE' | 'SWAP' | 'CONFIRMATION';

export interface TradeFailureAlertParams {
    side: 'BUY' | 'SELL';
    tokenMint: string;
    symbol?: string;
    reason: string;
    stage?: TradeFailureStage;
    amountUsd?: number;
    amountSol?: number;
    targetChatId?: string;
    route?: 'MICIN' | 'WHALE';
    details?: string;
}
