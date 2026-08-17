export interface HeliusTokenTransfer {
    fromUserAccount: string;
    toUserAccount: string;
    /** Raw amount, as sent by the webhook payload. */
    amount?: number;
    /**
     * Decimal-adjusted amount, as returned by the Enhanced Transactions REST API. Verified against
     * a live pumpswap response: a WSOL leg arrives as `tokenAmount: 0.513580556` with `amount`
     * absent entirely, so anything reading only `amount` silently measures nothing.
     */
    tokenAmount?: number;
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
