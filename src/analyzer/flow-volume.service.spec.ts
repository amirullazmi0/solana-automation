import { HeliusWebhookTransaction } from '../dto/helius-webhook.dto';
import {
    aggregateFlowVolume,
    classifySwap,
    isPageFullyStale,
} from './flow-volume.service';

const POOL = 'PoolAddress1111111111111111111111111111111';
const MINT = 'TokenMint11111111111111111111111111111111';
const TRADER = 'Trader111111111111111111111111111111111111';
const NOW = 1_700_000_000_000;
const WSOL = 'So11111111111111111111111111111111111111112';

function tx(overrides: Partial<HeliusWebhookTransaction> = {}): HeliusWebhookTransaction {
    return {
        description: '',
        type: 'SWAP',
        source: 'PUMP_AMM',
        status: 'success',
        signature: 'sig1',
        slot: 1,
        timestamp: Math.floor(NOW / 1000),
        tokenTransfers: [],
        nativeTransfers: [],
        accountData: [],
        ...overrides,
    };
}

/**
 * Token leaves the pool and wSOL enters it: a buy. Shaped like a real Enhanced Transactions
 * payload — wSOL travels in tokenTransfers as `tokenAmount`, and nativeTransfers carry only rent.
 */
function buyTx(sol = 1, signature = 'buy'): HeliusWebhookTransaction {
    return tx({
        signature,
        tokenTransfers: [
            { fromUserAccount: POOL, toUserAccount: TRADER, tokenAmount: 100, mint: MINT },
            { fromUserAccount: TRADER, toUserAccount: POOL, tokenAmount: sol, mint: WSOL },
        ],
        nativeTransfers: [{ fromUserAccount: TRADER, toUserAccount: POOL, amount: 2_039_280 }],
    });
}

/** Token enters the pool and wSOL leaves it: a sell. */
function sellTx(sol = 0.5, signature = 'sell'): HeliusWebhookTransaction {
    return tx({
        signature,
        tokenTransfers: [
            { fromUserAccount: TRADER, toUserAccount: POOL, tokenAmount: 100, mint: MINT },
            { fromUserAccount: POOL, toUserAccount: TRADER, tokenAmount: sol, mint: WSOL },
        ],
        nativeTransfers: [{ fromUserAccount: POOL, toUserAccount: TRADER, amount: 2_039_280 }],
    });
}

describe('classifySwap', () => {
    it('reads a buy from the token leaving the pool', () => {
        expect(classifySwap(buyTx(), MINT, POOL)).toEqual({ side: 'BUY', solAmount: 1 });
    });

    it('reads a sell from the token entering the pool', () => {
        expect(classifySwap(sellTx(), MINT, POOL)).toEqual({ side: 'SELL', solAmount: 0.5 });
    });

    it('ignores transactions that are not swaps', () => {
        expect(classifySwap(tx({ type: 'TRANSFER' }), MINT, POOL).side).toBeNull();
    });

    it('ignores a swap of some other token', () => {
        expect(classifySwap(buyTx(), 'OtherMint', POOL).side).toBeNull();
    });

    it('ignores a swap through a different pool', () => {
        expect(classifySwap(buyTx(), MINT, 'OtherPool').side).toBeNull();
    });

    // Counting a transfer that touches both sides would arbitrarily inflate one direction.
    it('skips an ambiguous transfer touching both sides of the pool', () => {
        const ambiguous = tx({
            tokenTransfers: [
                { fromUserAccount: POOL, toUserAccount: TRADER, tokenAmount: 100, mint: MINT },
                { fromUserAccount: TRADER, toUserAccount: POOL, tokenAmount: 100, mint: MINT },
                { fromUserAccount: TRADER, toUserAccount: POOL, tokenAmount: 1, mint: WSOL },
            ],
        });
        expect(classifySwap(ambiguous, MINT, POOL).side).toBeNull();
    });

    // A real swap carries protocol/creator fee legs in the same direction as the trade; summing
    // them would overstate size, so the largest single leg is used.
    it('takes the largest wSOL leg and ignores the fee legs', () => {
        const withFees = tx({
            tokenTransfers: [
                { fromUserAccount: POOL, toUserAccount: TRADER, tokenAmount: 100, mint: MINT },
                { fromUserAccount: TRADER, toUserAccount: POOL, tokenAmount: 0.513580556, mint: WSOL },
                { fromUserAccount: TRADER, toUserAccount: POOL, tokenAmount: 0.000129824, mint: WSOL },
                { fromUserAccount: TRADER, toUserAccount: POOL, tokenAmount: 0.004413989, mint: WSOL },
            ],
        });
        expect(classifySwap(withFees, MINT, POOL)).toEqual({
            side: 'BUY',
            solAmount: 0.513580556,
        });
    });

    // Rent is not trade size: a live payload showed 2,039,280 lamports of ATA rent alongside a
    // 0.51 SOL swap. Reading nativeTransfers would have measured the rent.
    it('never mistakes account rent for trade size', () => {
        const rentOnly = tx({
            tokenTransfers: [
                { fromUserAccount: POOL, toUserAccount: TRADER, tokenAmount: 100, mint: MINT },
            ],
            nativeTransfers: [{ fromUserAccount: TRADER, toUserAccount: POOL, amount: 2_039_280 }],
        });
        expect(classifySwap(rentOnly, MINT, POOL).side).toBeNull();
    });

    it('drops a swap with no measurable SOL leg', () => {
        const noSol = tx({
            tokenTransfers: [
                { fromUserAccount: POOL, toUserAccount: TRADER, tokenAmount: 100, mint: MINT },
            ],
        });
        expect(classifySwap(noSol, MINT, POOL).side).toBeNull();
    });
});

describe('aggregateFlowVolume', () => {
    const since = NOW - 60 * 60 * 1000;

    it('sums each side in SOL and counts the sample', () => {
        const result = aggregateFlowVolume(
            [buyTx(1, 'b1'), buyTx(1, 'b2'), sellTx(1, 's1')],
            MINT,
            POOL,
            since,
        );
        expect(result).toEqual({ buyVolumeSol: 2, sellVolumeSol: 1, buyCount: 2, sellCount: 1, sampled: 3 });
    });

    it('excludes transactions older than the window', () => {
        const stale = buyTx(1, 'old');
        stale.timestamp = Math.floor((since - 60_000) / 1000);
        const result = aggregateFlowVolume([stale, sellTx(1)], MINT, POOL, since);
        expect(result).toEqual({ buyVolumeSol: 0, sellVolumeSol: 1, buyCount: 0, sellCount: 1, sampled: 1 });
    });

    it('returns an empty sample rather than throwing on junk input', () => {
        expect(aggregateFlowVolume([], MINT, POOL, since)).toEqual({
            buyVolumeSol: 0,
            sellVolumeSol: 0,
            buyCount: 0,
            sellCount: 0,
            sampled: 0,
        });
    });
});

describe('isPageFullyStale', () => {
    const since = NOW - 60 * 60 * 1000;

    it('stops pagination once a whole page predates the window', () => {
        const old = buyTx(1, 'old');
        old.timestamp = Math.floor((since - 1000) / 1000);
        expect(isPageFullyStale([old], since)).toBe(true);
    });

    it('keeps paginating while any transaction is inside the window', () => {
        const old = buyTx(1, 'old');
        old.timestamp = Math.floor((since - 1000) / 1000);
        expect(isPageFullyStale([old, buyTx()], since)).toBe(false);
    });

    it('treats an empty page as stale', () => {
        expect(isPageFullyStale([], since)).toBe(true);
    });
});
