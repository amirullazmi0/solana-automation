import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HeliusLimiter } from '../common/helius-limiter';
import { HeliusWebhookTransaction } from '../dto/helius-webhook.dto';

export interface HourlyFlowVolume {
    /**
     * Measured in SOL rather than USD on purpose: the gate consumes a SHARE
     * (buy / (buy + sell)), and any single price factor cancels out of a share. Converting would
     * mean one more HTTP call on the entry path to learn a number that cannot change the answer.
     */
    buyVolumeSol: number;
    sellVolumeSol: number;
    /** Side counts, kept alongside volume so the two can be cross-checked against DexScreener. */
    buyCount: number;
    sellCount: number;
    /** How many swaps were actually classified, so a thin sample can be judged as thin. */
    sampled: number;
}

export interface SwapClassification {
    side: 'BUY' | 'SELL' | null;
    solAmount: number;
}

/** Wrapped SOL. AMM pools settle the SOL side of a swap through this mint, not native transfers. */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const HOUR_MS = 60 * 60 * 1000;

/**
 * Classifies a single parsed Helius transaction as a buy or a sell of `tokenMint` against a
 * specific pool, and reports the SOL value that changed hands.
 *
 * Direction is read from where the token went, which is unambiguous regardless of which
 * aggregator routed the trade:
 *   - token moved INTO the pool  -> someone sold it
 *   - token moved OUT of the pool -> someone bought it
 *
 * Size is taken from the SOL leg rather than the token amount, because the SOL leg is the actual
 * money moved; token amounts would need a price to become comparable, and that price is exactly
 * what is in question during a volatile hour.
 *
 * Exported as a pure function so it can be tested against recorded payloads without network access.
 */
export function classifySwap(
    tx: HeliusWebhookTransaction,
    tokenMint: string,
    poolAddress: string,
): SwapClassification {
    const none: SwapClassification = { side: null, solAmount: 0 };
    if (!tx || String(tx.type || '').toUpperCase() !== 'SWAP') return none;

    const transfers = tx.tokenTransfers || [];
    const relevant = transfers.filter((t) => t?.mint === tokenMint);
    if (relevant.length === 0) return none;

    const intoPool = relevant.some((t) => t.toUserAccount === poolAddress);
    const outOfPool = relevant.some((t) => t.fromUserAccount === poolAddress);

    // A transfer touching neither side of this pool belongs to some other route in the same tx.
    // A transfer touching BOTH is ambiguous (internal rebalancing, multi-hop through the same
    // pool); counting it would inflate one side arbitrarily, so it is skipped.
    if (intoPool === outOfPool) return none;

    const side: 'BUY' | 'SELL' = outOfPool ? 'BUY' : 'SELL';

    // Verified against a live pumpswap swap: SOL moves as WRAPPED SOL inside tokenTransfers, while
    // `nativeTransfers` on the same transaction held only account rent (2,039,280 lamports of ATA
    // rent). Reading nativeTransfers therefore measures rent, not trade size — it must not be used.
    //
    // On a buy the pool RECEIVES wSOL; on a sell it SENDS wSOL. Restricting to that direction drops
    // the fee legs that travel the other way.
    const wsolLegs = (tx.tokenTransfers || [])
        .filter((t) => t?.mint === WSOL_MINT)
        .filter((t) =>
            side === 'BUY' ? t.toUserAccount === poolAddress : t.fromUserAccount === poolAddress,
        )
        .map((t) => Math.abs(Number(t.tokenAmount ?? 0)))
        .filter((amount) => Number.isFinite(amount) && amount > 0);

    // The largest leg, not the sum: a single swap carries protocol and creator fee transfers in the
    // same direction (0.0001-0.004 SOL against a 0.51 SOL trade), and summing them double-counts.
    const solAmount = wsolLegs.length > 0 ? Math.max(...wsolLegs) : 0;

    if (!Number.isFinite(solAmount) || solAmount <= 0) return none;
    return { side, solAmount };
}

/** Sums a page of transactions into buy/sell SOL volume, ignoring anything older than the window. */
export function aggregateFlowVolume(
    transactions: HeliusWebhookTransaction[],
    tokenMint: string,
    poolAddress: string,
    since: number,
): HourlyFlowVolume {
    let buyVolumeSol = 0;
    let sellVolumeSol = 0;
    let buyCount = 0;
    let sellCount = 0;
    let sampled = 0;

    for (const tx of transactions || []) {
        // Helius timestamps are unix seconds.
        const timestampMs = Number(tx?.timestamp) * 1000;
        if (!Number.isFinite(timestampMs) || timestampMs < since) continue;

        const { side, solAmount } = classifySwap(tx, tokenMint, poolAddress);
        if (!side) continue;

        if (side === 'BUY') {
            buyVolumeSol += solAmount;
            buyCount += 1;
        } else {
            sellVolumeSol += solAmount;
            sellCount += 1;
        }
        sampled += 1;
    }

    return { buyVolumeSol, sellVolumeSol, buyCount, sellCount, sampled };
}

/** True once a page is entirely older than the window, so pagination can stop early. */
export function isPageFullyStale(
    transactions: HeliusWebhookTransaction[],
    since: number,
): boolean {
    if (!transactions || transactions.length === 0) return true;
    return transactions.every((tx) => Number(tx?.timestamp) * 1000 < since);
}

@Injectable()
export class FlowVolumeService {
    private readonly logger = new Logger(FlowVolumeService.name);
    private readonly cache = new Map<string, { value: HourlyFlowVolume; expiresAt: number }>();

    constructor(private readonly configService: ConfigService) {}

    /**
     * Buy vs sell SOL volume for the last hour, or null when it could not be determined.
     *
     * Callers must treat null as "no opinion" rather than as a rejection — see the
     * FLOW_VOLUME_FAIL_OPEN handling at the call site.
     */
    async getHourlyFlowVolume(
        tokenMint: string,
        poolAddress: string,
    ): Promise<HourlyFlowVolume | null> {
        if (!tokenMint || !poolAddress) return null;

        const cached = this.cache.get(tokenMint);
        if (cached && cached.expiresAt > Date.now()) return cached.value;

        const apiKey = this.extractHeliusApiKey();
        if (!apiKey) {
            this.logger.warn(
                '[FlowVolume] SOLANA_RPC_URL is not a Helius URL with an api-key; flow volume unavailable.',
            );
            return null;
        }

        const maxPages = Math.max(1, this.getNumber('HELIUS_FLOW_MAX_PAGES', 3));
        const since = Date.now() - HOUR_MS;

        const total: HourlyFlowVolume = {
            buyVolumeSol: 0,
            sellVolumeSol: 0,
            buyCount: 0,
            sellCount: 0,
            sampled: 0,
        };
        let before = '';

        try {
            for (let page = 0; page < maxPages; page++) {
                const url =
                    `https://api.helius.xyz/v0/addresses/${poolAddress}/transactions` +
                    `?api-key=${apiKey}&limit=100${before ? `&before=${before}` : ''}`;

                const response = await HeliusLimiter.get<HeliusWebhookTransaction[]>(url, {
                    timeout: 8000,
                });
                const transactions = Array.isArray(response.data) ? response.data : [];
                if (transactions.length === 0) break;

                const pageTotals = aggregateFlowVolume(transactions, tokenMint, poolAddress, since);
                total.buyVolumeSol += pageTotals.buyVolumeSol;
                total.sellVolumeSol += pageTotals.sellVolumeSol;
                total.buyCount += pageTotals.buyCount;
                total.sellCount += pageTotals.sellCount;
                total.sampled += pageTotals.sampled;

                // Everything on this page predates the window, so earlier pages will too.
                if (isPageFullyStale(transactions, since)) break;

                before = transactions[transactions.length - 1]?.signature || '';
                if (!before) break;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[FlowVolume] Helius lookup failed for ${tokenMint}: ${msg}.`);
            return null;
        }

        if (total.sampled === 0) return null;

        this.cache.set(tokenMint, {
            value: total,
            expiresAt: Date.now() + Math.max(1000, this.getNumber('HELIUS_FLOW_CACHE_TTL_MS', 60000)),
        });
        this.pruneCache();

        this.logger.debug(
            `[FlowVolume] ${tokenMint} buyVol=${total.buyVolumeSol.toFixed(4)} SOL sellVol=${total.sellVolumeSol.toFixed(4)} SOL buys=${total.buyCount} sells=${total.sellCount} swaps=${total.sampled}`,
        );
        return total;
    }

    /** The Helius RPC URL carries the key as `?api-key=...`; the REST API needs the same key. */
    private extractHeliusApiKey(): string {
        const rpcUrl = this.configService.get<string>('SOLANA_RPC_URL') || '';
        if (!rpcUrl.includes('helius')) return '';
        const match = rpcUrl.match(/[?&]api-key=([^&]+)/i);
        return match?.[1] ?? '';
    }

    private getNumber(key: string, fallback: number): number {
        const value = Number.parseFloat(String(this.configService.get(key, String(fallback))));
        return Number.isFinite(value) ? value : fallback;
    }

    private pruneCache(): void {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (entry.expiresAt <= now) this.cache.delete(key);
        }
    }
}
