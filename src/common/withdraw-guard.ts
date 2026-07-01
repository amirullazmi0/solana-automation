export type WithdrawGuardReason =
    | 'withdrawals_disabled'
    | 'chat_not_allowed'
    | 'wallet_not_connected'
    | 'wallet_mismatch';

export function parseChatIdList(raw?: string | null): string[] {
    return Array.from(
        new Set(
            (raw || '')
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean),
        ),
    );
}

export function isWithdrawalsEnabled(raw?: string | boolean | null): boolean {
    if (typeof raw === 'boolean') return raw;
    return ['true', '1', 'yes', 'on'].includes((raw || '').trim().toLowerCase());
}

export function isWithdrawChatAllowed(chatId: string, allowedChatIds: string[]): boolean {
    return allowedChatIds.map((id) => id.trim()).includes(chatId.trim());
}

export function validateWithdrawAccess(params: {
    chatId: string;
    withdrawalsEnabled: boolean;
    allowedChatIds: string[];
    walletPublicKey?: string | null;
    signerPublicKey?: string | null;
}): { allowed: true } | { allowed: false; reason: WithdrawGuardReason } {
    if (!params.withdrawalsEnabled) {
        return { allowed: false, reason: 'withdrawals_disabled' };
    }
    if (!isWithdrawChatAllowed(params.chatId, params.allowedChatIds)) {
        return { allowed: false, reason: 'chat_not_allowed' };
    }
    if (!params.walletPublicKey) {
        return { allowed: false, reason: 'wallet_not_connected' };
    }
    if (params.signerPublicKey && params.signerPublicKey !== params.walletPublicKey) {
        return { allowed: false, reason: 'wallet_mismatch' };
    }
    return { allowed: true };
}
