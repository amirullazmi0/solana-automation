import {
    AccountState,
    getDefaultAccountState,
    getNonTransferable,
    getPermanentDelegate,
    getTransferFeeConfig,
    getTransferHook,
    Mint,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

const ZERO_AUTHORITY = new PublicKey('11111111111111111111111111111111');

export interface MintSafetyResult {
    safe: boolean;
    reason?: string;
}

function hasAuthority(authority: PublicKey | null | undefined): boolean {
    return Boolean(authority && !authority.equals(ZERO_AUTHORITY));
}

export function evaluateMintSafety(mint: Mint, maxTransferFeeBps: number): MintSafetyResult {
    if (mint.mintAuthority !== null) return { safe: false, reason: 'mint_authority_active' };
    if (mint.freezeAuthority !== null) return { safe: false, reason: 'freeze_authority_active' };

    try {
        if (getNonTransferable(mint) !== null) {
            return { safe: false, reason: 'token_2022_non_transferable' };
        }
        if (getPermanentDelegate(mint) !== null) {
            return { safe: false, reason: 'token_2022_permanent_delegate' };
        }
        if (getTransferHook(mint) !== null) {
            return { safe: false, reason: 'token_2022_transfer_hook' };
        }

        const defaultAccountState = getDefaultAccountState(mint);
        if (defaultAccountState?.state === AccountState.Frozen) {
            return { safe: false, reason: 'token_2022_default_frozen' };
        }

        const transferFee = getTransferFeeConfig(mint);
        if (transferFee) {
            if (hasAuthority(transferFee.transferFeeConfigAuthority)) {
                return { safe: false, reason: 'token_2022_mutable_transfer_fee' };
            }
            const highestFeeBps = Math.max(
                transferFee.olderTransferFee.transferFeeBasisPoints,
                transferFee.newerTransferFee.transferFeeBasisPoints,
            );
            if (highestFeeBps > Math.max(0, maxTransferFeeBps)) {
                return {
                    safe: false,
                    reason: `token_2022_transfer_fee_too_high:${highestFeeBps}`,
                };
            }
        }
    } catch {
        return { safe: false, reason: 'token_extension_parse_failed' };
    }

    return { safe: true };
}
