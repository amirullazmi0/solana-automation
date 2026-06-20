export interface HeliusTokenTransfer {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
    mint: string;
}

export interface HeliusTransaction {
    description: string;
    type: string;
    source: string;
    signature: string;
    slot: number;
    timestamp: number;
    tokenTransfers: HeliusTokenTransfer[];
}
