import { ExtensionType, Mint } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { evaluateMintSafety } from './token-mint-safety';

const MINT_ADDRESS = new PublicKey('So11111111111111111111111111111111111111112');

function mint(overrides: Partial<Mint> = {}): Mint {
    return {
        address: MINT_ADDRESS,
        mintAuthority: null,
        supply: 1_000_000n,
        decimals: 6,
        isInitialized: true,
        freezeAuthority: null,
        tlvData: Buffer.alloc(0),
        ...overrides,
    };
}

function emptyExtension(type: ExtensionType): Buffer {
    const data = Buffer.alloc(4);
    data.writeUInt16LE(type, 0);
    data.writeUInt16LE(0, 2);
    return data;
}

describe('evaluateMintSafety', () => {
    it('accepts a standard immutable SPL mint', () => {
        expect(evaluateMintSafety(mint(), 300)).toEqual({ safe: true });
    });

    it('rejects active mint and freeze authorities', () => {
        expect(evaluateMintSafety(mint({ mintAuthority: MINT_ADDRESS }), 300).reason).toBe(
            'mint_authority_active',
        );
        expect(evaluateMintSafety(mint({ freezeAuthority: MINT_ADDRESS }), 300).reason).toBe(
            'freeze_authority_active',
        );
    });

    it('rejects a Token-2022 non-transferable extension', () => {
        expect(
            evaluateMintSafety(
                mint({ tlvData: emptyExtension(ExtensionType.NonTransferable) }),
                300,
            ).reason,
        ).toBe('token_2022_non_transferable');
    });
});
