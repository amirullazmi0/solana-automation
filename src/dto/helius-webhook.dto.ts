export interface HeliusTokenTransfer {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
    mint: string;
}

export interface HeliusNativeTransfer {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
}

export interface HeliusAccountDataChange {
    account: string;
    mint?: string;
    nativeBalanceChange?: number;
}

export interface HeliusWebhookEventData {
    tokenTransfers?: HeliusTokenTransfer[];
    nativeTransfers?: HeliusNativeTransfer[];
    accountData?: HeliusAccountDataChange[];
}

export interface HeliusWebhookTransaction {
    description: string;
    type: string;
    source: string;
    status: string;
    signature: string;
    slot: number;
    timestamp: number;
    tokenTransfers: HeliusTokenTransfer[];
    nativeTransfers?: HeliusNativeTransfer[];
    accountData?: HeliusAccountDataChange[];
    events?: HeliusWebhookEventData;
}

export type HeliusWebhookPayload = HeliusWebhookTransaction | HeliusWebhookTransaction[];

export interface HeliusWebhookProcessingResult {
    accepted: boolean;
    processed: number;
    mints: string[];
    note?: string;
}

export type HeliusTransaction = HeliusWebhookTransaction;
