/**
 * rpc-retry.ts
 *
 * Rate-limit-aware retry + multi-endpoint failover primitives for the
 * critical trading path (stop-loss / sell). Pure and dependency-free so it can
 * be unit-tested with mocked RPC and reused across services.
 *
 * Requirement provenance (proposal solana-stoploss-retry):
 *   (1) bounded exponential backoff + jitter on 429/5xx/timeout
 *   (2) multi-RPC failover (rotate 2-3 endpoints on rate-limit)
 *   (3) IDEMPOTENCY: never blind-retry a re-submit after an ambiguous failure —
 *       a double-sell is worse than the bug. `withRpcRetry` exposes an
 *       `isSafeToRetry` gate that the caller uses to check order/position state
 *       before any re-attempt.
 */

export type RpcErrorClass = 'RATE_LIMIT' | 'SERVER' | 'TIMEOUT' | 'OTHER';

interface AxiosishError {
    code?: string;
    response?: { status?: number };
    status?: number;
    message?: string;
}

/**
 * Classify an arbitrary thrown error into a transport class using axios-shaped
 * fields first, then a message-substring fallback (Solana web3.js RPC errors
 * surface the HTTP status only inside the message string).
 */
export function classifyRpcError(error: unknown): RpcErrorClass {
    const e = (error ?? {}) as AxiosishError;
    const status = e.response?.status ?? e.status;
    const code = typeof e.code === 'string' ? e.code : '';
    const message = typeof e.message === 'string' ? e.message : String(error ?? '');

    // Timeout: axios aborts with ECONNABORTED; node sockets use ETIMEDOUT.
    if (
        code === 'ECONNABORTED' ||
        code === 'ETIMEDOUT' ||
        code === 'ESOCKETTIMEDOUT' ||
        /timed?\s*out|timeout/i.test(message)
    ) {
        // A 5xx/429 that also mentions timeout still classifies by status below.
        if (status === undefined) return 'TIMEOUT';
    }

    if (status === 429 || /\b429\b|too many requests|rate.?limit/i.test(message)) {
        return 'RATE_LIMIT';
    }
    if ((typeof status === 'number' && status >= 500 && status <= 599) || /\b5\d\d\b/.test(message)) {
        return 'SERVER';
    }
    // Network resets are transient too; treat as SERVER-tier retryable.
    if (code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return 'SERVER';
    }
    return 'OTHER';
}

/** True for transport failures worth retrying (429 / 5xx / timeout / net reset). */
export function isRetryableRpcError(error: unknown): boolean {
    const c = classifyRpcError(error);
    return c === 'RATE_LIMIT' || c === 'SERVER' || c === 'TIMEOUT';
}

/**
 * After a transaction *send/submit* call THROWS, decide whether the tx may
 * ALREADY have been forwarded to the network — in which case the caller must
 * reconcile the exact signature on-chain and MUST NOT blind re-submit (a
 * double-execution is worse than the original failure) — versus a DEFINITIVE
 * pre-broadcast rejection, where nothing was forwarded and a retry/normal-fail is
 * safe.
 *
 * Returns TRUE (ambiguous — treat as possibly broadcast) for:
 *   - transport timeouts (ECONNABORTED / ETIMEDOUT): the send may have reached
 *     the leader before the socket gave up;
 *   - connection resets / 5xx: server-side, forwarding state is unknown.
 * Returns FALSE (definitively pre-broadcast — safe to retry) for:
 *   - preflight / simulation failures: `sendRawTransaction({skipPreflight:false})`
 *     throws during simulation, BEFORE forwarding to the leader — this is the
 *     misclassification the "broadcasted set before the wire send" bug caused;
 *   - expired-blockhash / block-height-exceeded: even if forwarded, the tx can
 *     never land, so a fresh-blockhash retry is safe;
 *   - explicit RPC rate-limit (429): the provider refused the request outright;
 *   - other structured/clean rejections (RPC error objects).
 *
 * Provenance: proposal solana-stoploss-retry requirement 3.
 */
export function isAmbiguousSendFailure(error: unknown): boolean {
    const rawMessage = (error as { message?: unknown } | null)?.message;
    const message = typeof rawMessage === 'string' ? rawMessage : String(error ?? '');

    // Definitive PRE-broadcast rejections detectable from the message. Checked
    // FIRST so a simulation log that happens to contain 5xx-looking digits can't
    // be misclassified as an (ambiguous) SERVER timeout by classifyRpcError.
    if (
        /simulation failed|failed to simulate|preflight|blockhash not found|blockhashnotfound|block height exceeded|blockheightexceeded|insufficient funds|custom program error|instruction ?error|transaction too large|invalid transaction/i.test(
            message,
        )
    ) {
        return false;
    }

    const cls = classifyRpcError(error);
    if (cls === 'RATE_LIMIT') return false; // provider refused; nothing forwarded
    if (cls === 'TIMEOUT' || cls === 'SERVER') return true; // may have been forwarded
    return false; // OTHER: structured/clean rejection → pre-broadcast
}

export interface BackoffOptions {
    /** First-attempt base delay in ms (default 750). */
    baseMs?: number;
    /** Hard ceiling per delay in ms (default 8000). */
    maxMs?: number;
    /** Fraction of the delay applied as +/- jitter, 0..1 (default 0.5). */
    jitterRatio?: number;
}

/**
 * Bounded exponential backoff with symmetric jitter.
 *
 * @param attempt 0-based retry index (0 = first retry).
 * @param rng     injectable RNG for deterministic tests (default Math.random).
 * @returns a non-negative integer millisecond delay, always <= maxMs.
 */
export function computeBackoffDelay(
    attempt: number,
    opts: BackoffOptions = {},
    rng: () => number = Math.random,
): number {
    const baseMs = opts.baseMs ?? 750;
    const maxMs = opts.maxMs ?? 8000;
    const jitterRatio = Math.min(Math.max(opts.jitterRatio ?? 0.5, 0), 1);

    const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
    // 2^attempt can overflow for pathological inputs; cap the exponent.
    const exp = Math.min(safeAttempt, 30);
    const raw = Math.min(baseMs * Math.pow(2, exp), maxMs);

    // Symmetric jitter in [-jitterRatio, +jitterRatio] * raw.
    const jitter = raw * jitterRatio * (rng() * 2 - 1);
    const delay = Math.round(raw + jitter);
    return Math.max(0, Math.min(delay, maxMs));
}

/**
 * Ordered pool of RPC endpoints. The first configured endpoint is the primary;
 * `rotate()` advances round-robin so a rate-limited provider is skipped on the
 * next attempt. Empty/duplicate URLs are dropped while preserving order.
 */
export class RpcEndpointPool {
    private readonly urls: string[];
    private index = 0;

    constructor(endpoints: Array<string | null | undefined>) {
        const seen = new Set<string>();
        this.urls = [];
        for (const raw of endpoints) {
            const url = (raw ?? '').trim();
            if (!url || seen.has(url)) continue;
            seen.add(url);
            this.urls.push(url);
        }
        if (this.urls.length === 0) {
            throw new Error('RpcEndpointPool requires at least one non-empty endpoint URL.');
        }
    }

    get current(): string {
        return this.urls[this.index];
    }

    get size(): number {
        return this.urls.length;
    }

    /** Snapshot of the configured endpoints in priority order. */
    endpoints(): string[] {
        return [...this.urls];
    }

    /** Advance to the next endpoint (round-robin) and return it. */
    rotate(): string {
        if (this.urls.length > 1) {
            this.index = (this.index + 1) % this.urls.length;
        }
        return this.current;
    }
}

/**
 * Build the endpoint priority list from config values.
 * Order: primary (SOLANA_RPC_URL) -> secondary (RPC_ENDPOINT) ->
 * comma/whitespace-separated SOLANA_RPC_FALLBACKS -> hardcoded public fallback.
 * Dedup/empty-filtering happens in RpcEndpointPool.
 */
export function parseRpcEndpoints(
    primary?: string | null,
    secondary?: string | null,
    fallbacksCsv?: string | null,
    hardcoded = 'https://api.mainnet-beta.solana.com',
): string[] {
    const fromCsv = (fallbacksCsv ?? '')
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    return [primary ?? '', secondary ?? '', ...fromCsv, hardcoded].map((s) => (s ?? '').trim());
}

export interface WithRpcRetryOptions {
    /** Total attempts including the first (default 5). Clamped to >= 1. */
    maxAttempts: number;
    backoff?: BackoffOptions;
    /** Injectable sleep for tests; default resolves after `computeBackoffDelay`. */
    sleep?: (ms: number) => Promise<void>;
    /** Injectable RNG for jitter (test determinism). */
    rng?: () => number;
    /**
     * Invoked whenever a RATE_LIMIT error is seen, before the next attempt.
     * Wire this to RpcEndpointPool.rotate() + Connection rebuild.
     */
    onRateLimit?: (attempt: number, error: unknown) => void | Promise<void>;
    /**
     * IDEMPOTENCY GATE. Called before every re-attempt (attempt > 0). Return
     * false to abort retrying because a re-submit would be unsafe (e.g. the
     * position may already be closed / the prior tx may have landed). When it
     * returns false, `withRpcRetry` rethrows the last error instead of retrying.
     * Omit for read-only operations where re-submit is always safe.
     */
    isSafeToRetry?: (attempt: number, error: unknown) => boolean | Promise<boolean>;
    /** Called once when all attempts are exhausted (or a retry was blocked). */
    onExhausted?: (error: unknown, attempts: number) => void | Promise<void>;
    /** Only retry when this returns true (default: isRetryableRpcError). */
    shouldRetry?: (error: unknown) => boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Retry an async RPC/DEX operation with rate-limit-aware backoff, endpoint
 * rotation, and an idempotency gate. Generic over the operation result.
 *
 * The operation receives the 0-based attempt number so it can, e.g., raise
 * slippage or pick the pool's current endpoint per attempt.
 */
export async function withRpcRetry<T>(
    fn: (attempt: number) => Promise<T>,
    opts: WithRpcRetryOptions,
): Promise<T> {
    const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts));
    const sleep = opts.sleep ?? defaultSleep;
    const rng = opts.rng ?? Math.random;
    const shouldRetry = opts.shouldRetry ?? isRetryableRpcError;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            const isLast = attempt >= maxAttempts - 1;
            if (isLast || !shouldRetry(error)) {
                break;
            }

            // IDEMPOTENCY: verify a re-submit is safe before doing it.
            if (opts.isSafeToRetry) {
                const safe = await opts.isSafeToRetry(attempt, error);
                if (!safe) {
                    // Abort the retry loop — re-submitting could double-execute.
                    break;
                }
            }

            if (classifyRpcError(error) === 'RATE_LIMIT' && opts.onRateLimit) {
                await opts.onRateLimit(attempt, error);
            }

            const delay = computeBackoffDelay(attempt, opts.backoff, rng);
            await sleep(delay);
        }
    }

    if (opts.onExhausted) {
        await opts.onExhausted(lastError, maxAttempts);
    }
    throw lastError;
}
