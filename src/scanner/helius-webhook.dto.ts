export interface HeliusWebhookTokenTransfer {
    mint: string;
    fromUserAccount?: string | null;
    toUserAccount?: string | null;
}

export interface HeliusWebhookAccountDataChange {
    mint?: string | null;
    tokenAccount?: string | null;
    userAccount?: string | null;
}

export interface HeliusWebhookEventData {
    tokenTransfers?: HeliusWebhookTokenTransfer[];
    accountData?: HeliusWebhookAccountDataChange[];
}

export interface HeliusWebhookTransaction {
    signature?: string;
    type?: string;
    description?: string;
    tokenTransfers?: HeliusWebhookTokenTransfer[];
    accountData?: HeliusWebhookAccountDataChange[];
    events?: HeliusWebhookEventData;
}

export type HeliusWebhookPayload = HeliusWebhookTransaction | HeliusWebhookTransaction[];

export interface HeliusWebhookProcessingResult {
    accepted: boolean;
    processed: number;
    mints: string[];
    note?: string;
}
