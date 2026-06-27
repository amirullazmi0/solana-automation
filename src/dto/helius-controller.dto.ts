export interface NativeDepositBatch {
    walletPublicKey: string;
    amountLamports: number;
}

export interface DepositLedgerInsertResult {
    chatId: string;
    newBalanceSol: number;
    amountSol: number;
}
