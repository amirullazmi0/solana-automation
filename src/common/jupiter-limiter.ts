import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * SELL = protective (exiting a losing/winning position) — always dispatched before BUY.
 * BUY = opportunistic (new entry) — can tolerate being delayed or dropped.
 */
export type JupiterPriority = 'SELL' | 'BUY';

interface JupiterQueueItem {
    method: 'GET' | 'POST';
    url: string;
    data?: unknown;
    config?: AxiosRequestConfig;
    priority: JupiterPriority;
    // This limiter is a thin passthrough wrapper around axios.get/axios.post, and must
    // preserve axios's own default response typing (`AxiosResponse<any>`) for the many
    // existing call sites in trade.service.ts that read `.data.<field>` without ever
    // specifying a generic. Constraining this to `object` (like DexLimiter does) would
    // force those untyped accesses to be re-typed as an unrelated, out-of-scope change.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve: (value: AxiosResponse<any>) => void;
    reject: (reason: Error) => void;
    // Fires if this item is still sitting in its queue (not yet dispatched) after its
    // wait budget expires — see MAX_QUEUE_WAIT_MS. Cleared as soon as the item is picked
    // for dispatch so it never fires post-dispatch.
    waitTimeout: ReturnType<typeof setTimeout>;
}

/**
 * Shared rate limiter/queue for Jupiter API calls (quote GET, swap-build POST, and the
 * SOL/USD price GET). Jupiter's quote/swap endpoints and the DexScreener endpoints
 * covered by DexLimiter are separate providers/budgets, so this is intentionally its
 * own limiter rather than reusing DexLimiter directly — but it mirrors DexLimiter's
 * queue/spacing/retry structure since no general-purpose concurrency-limiting library
 * (p-limit, p-queue, bottleneck, etc.) is installed in this project.
 *
 * Two priority lanes instead of DexLimiter's single FIFO queue:
 *  - SELL requests always drain before BUY requests when both are queued.
 *  - On a 429: SELL retries in-place (with backoff) through the limiter itself, because a
 *    SELL failure leaves a position dangerously unmanaged. BUY aborts immediately on a
 *    429 (rejects, no in-limiter retry) so an opportunistic entry never adds extra load
 *    to an already-rate-limited endpoint while a protective SELL may be waiting.
 *
 * Not cached (unlike DexLimiter) — quote/swap/price data must always be fresh for trade
 * execution.
 */
export class JupiterLimiter {
    private static sellQueue: JupiterQueueItem[] = [];
    private static buyQueue: JupiterQueueItem[] = [];
    private static processing = false;

    // Two independent spacing clocks, keyed by endpoint family (see isPriceEndpoint()),
    // instead of one shared clock for every Jupiter call. A single SELL (executeJupiterSwap)
    // makes several sequential dispatches -- quote GET, the SOL/token price GET(s), and the
    // swap-build POST -- and with ONE shared clock each of those pays a fresh MIN_DELAY_MS
    // gate against the PREVIOUS dispatch even though quote/swap (/swap/v1/*) and price
    // (/price/v3) are different REST resources, not the same budget. Splitting the clock so
    // quote/swap only gate against each other, and price lookups only gate against each
    // other, removes that avoidable serialized latency from the SELL critical path while
    // still spacing same-family requests by MIN_DELAY_MS exactly as before.
    private static lastTradeRequestTime = 0;
    private static lastPriceRequestTime = 0;

    // Jeda minimal antar request — reuses DexLimiter's 500ms default; no documented
    // Jupiter-specific reason to differ.
    private static readonly MIN_DELAY_MS = 500;

    // Hard backstop so a hung in-flight request (e.g. a future caller that omits its own
    // axios `timeout`) can never block the single shared queue forever. Set comfortably
    // above every timeout currently passed by callers (TRADE_TIMEOUT_MS default 20000ms,
    // and the 3000/5000ms price-lookup timeouts) so well-behaved callers are unaffected —
    // this is a backstop, not a replacement for per-call timeouts.
    private static readonly EXECUTION_DEADLINE_MS = 30_000;

    // Mirrors DexLimiter's retry count, but ONLY applies to the SELL lane (see class doc).
    private static readonly SELL_MAX_ATTEMPTS = 3;

    // Bounds each lane so a runaway caller (or a genuinely unbounded burst) can't grow
    // these arrays without limit. Set well above the steady-state depth implied by
    // MIN_DELAY_MS + the wait timeouts below (e.g. SELL: ~30s budget / 500ms spacing ≈ 60
    // items), so it only trips on pathological growth, not ordinary heavy load.
    private static readonly MAX_QUEUE_SIZE = 200;

    // Dispatch is fire-and-forget (see the `void this.executeRequest(item)` call in
    // processQueue() below) so MIN_DELAY_MS only gates how often a NEW item is dispatched,
    // not how many previously-dispatched items are still in flight (e.g. a SELL mid its
    // 429 retry/backoff loop, which can hold its slot for up to
    // SELL_MAX_ATTEMPTS * EXECUTION_DEADLINE_MS). Without a separate cap, a sustained burst
    // of slow/retrying requests plus a steady stream of new dispatches could grow
    // concurrent in-flight requests without bound. Set comfortably above the concurrency a
    // healthy system produces (PRICE_MONITOR_CONCURRENCY_LIMIT concurrent trades, each with
    // a small sequential fan-out of quote/price/swap calls) so this only trips as a
    // pathological-growth backstop, mirroring MAX_QUEUE_SIZE's role for queue depth.
    private static readonly MAX_CONCURRENT_INFLIGHT = 20;

    // Per-lane counts of items dispatched (past the queue) but not yet settled. Incremented
    // right before each fire-and-forget executeRequest() call and decremented when that
    // call's promise settles, regardless of outcome. Kept separate per lane (SELL vs BUY)
    // rather than one shared counter: a single shared counter let a saturated BUY lane hold
    // all MAX_CONCURRENT_INFLIGHT slots and block a SELL sitting at the front of sellQueue
    // from dispatching at all, breaking the "SELL always drains before BUY" invariant
    // documented above. Each lane is capped at MAX_CONCURRENT_INFLIGHT independently instead,
    // so BUY saturation can never hold back a SELL dispatch.
    private static sellInFlightCount = 0;
    private static buyInFlightCount = 0;

    // Every queued item is guaranteed to settle (resolve OR reject) within this budget,
    // even if it never reaches the front of its lane. Without this, a BUY item could sit
    // enqueued with its promise never settling for as long as SELL traffic keeps arriving,
    // since the SELL lane always drains first (see class doc). BUY is opportunistic and can
    // tolerate being dropped, so it gets the shorter budget; SELL is protective and gets a
    // longer one, but must still eventually settle rather than wait forever.
    private static readonly BUY_MAX_QUEUE_WAIT_MS = 15_000;
    private static readonly SELL_MAX_QUEUE_WAIT_MS = 30_000;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public static async get<T = any>(
        url: string,
        priority: JupiterPriority,
        config?: AxiosRequestConfig,
    ): Promise<AxiosResponse<T>> {
        return this.enqueue<T>('GET', url, undefined, priority, config);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public static async post<T = any>(
        url: string,
        data: unknown,
        priority: JupiterPriority,
        config?: AxiosRequestConfig,
    ): Promise<AxiosResponse<T>> {
        return this.enqueue<T>('POST', url, data, priority, config);
    }

    private static enqueue<T>(
        method: 'GET' | 'POST',
        url: string,
        data: unknown,
        priority: JupiterPriority,
        config?: AxiosRequestConfig,
    ): Promise<AxiosResponse<T>> {
        return new Promise<AxiosResponse<T>>((resolve, reject) => {
            const queue = priority === 'SELL' ? this.sellQueue : this.buyQueue;

            if (queue.length >= this.MAX_QUEUE_SIZE) {
                reject(
                    new Error(
                        `[JupiterLimiter] ${priority} queue is full (>= ${this.MAX_QUEUE_SIZE} pending); rejecting ${url}`,
                    ),
                );
                return;
            }

            const maxWaitMs =
                priority === 'SELL' ? this.SELL_MAX_QUEUE_WAIT_MS : this.BUY_MAX_QUEUE_WAIT_MS;

            const item: JupiterQueueItem = {
                method,
                url,
                data,
                config,
                priority,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                resolve: resolve as (value: AxiosResponse<any>) => void,
                reject,
                // Rescues this item if it is still sitting in its queue (never dispatched)
                // once its wait budget expires. Reads this.sellQueue/this.buyQueue fresh
                // (not the captured `queue`) so it stays correct even if resetForTests()
                // has reassigned the arrays. Cleared on dispatch in processQueue().
                waitTimeout: setTimeout(() => {
                    const laneQueue = item.priority === 'SELL' ? this.sellQueue : this.buyQueue;
                    const idx = laneQueue.indexOf(item);
                    if (idx === -1) return; // already dispatched
                    laneQueue.splice(idx, 1);
                    reject(
                        new Error(
                            `[JupiterLimiter] ${priority} request to ${url} timed out after ${maxWaitMs}ms waiting in queue`,
                        ),
                    );
                }, maxWaitMs),
            };

            queue.push(item);
            this.processQueue();
        });
    }

    /** True for the Jupiter Price API (`/price/v3`) — a different REST resource/budget
     *  from the quote/swap-build endpoints (`/swap/v1/*`), so it gets its own spacing
     *  clock (see lastPriceRequestTime doc above). */
    private static isPriceEndpoint(url: string): boolean {
        return url.includes('/price/');
    }

    private static async processQueue(): Promise<void> {
        if (this.processing) return;
        this.processing = true;

        // Yield one tick before the very first dispatch of a fresh batch. Without this,
        // a BUY enqueued microseconds before a SELL (both from the same synchronous
        // event-loop turn, e.g. a price-monitor tick evaluating several trades) could
        // start executing immediately — before the SELL even reaches its queue — which
        // would defeat the SELL-always-first guarantee. This tick gives same-turn
        // requests a chance to land in their lane before the first pick.
        await new Promise((res) => setTimeout(res, 0));

        while (this.sellQueue.length > 0 || this.buyQueue.length > 0) {
            // Peek (don't remove yet): SELL lane always drains before BUY, a protective
            // exit must never wait behind an opportunistic entry.
            const peeked = this.sellQueue.length > 0 ? this.sellQueue[0] : this.buyQueue[0];

            // Concurrency backstop (see MAX_CONCURRENT_INFLIGHT doc above): with dispatch
            // now fire-and-forget, hold off dispatching anything new in THIS lane while too
            // many previously-dispatched items from the SAME lane are still in flight. Gated
            // per-lane (against the peeked item's own lane count), never against a combined
            // total, so a saturated BUY lane can never hold back a SELL sitting at the front
            // of sellQueue — that would break the SELL-before-BUY invariant. Cheap re-poll.
            const inFlightForPeekedLane =
                peeked.priority === 'SELL' ? this.sellInFlightCount : this.buyInFlightCount;
            if (inFlightForPeekedLane >= this.MAX_CONCURRENT_INFLIGHT) {
                await new Promise((res) => setTimeout(res, 25));
                continue;
            }

            const lastRequestTime = this.isPriceEndpoint(peeked.url)
                ? this.lastPriceRequestTime
                : this.lastTradeRequestTime;

            const now = Date.now();
            const elapsed = now - lastRequestTime;
            if (elapsed < this.MIN_DELAY_MS) {
                await new Promise((res) => setTimeout(res, this.MIN_DELAY_MS - elapsed));
                // Re-evaluate from the top: a higher-priority (SELL) item, or one from a
                // different endpoint family, may have arrived while we were waiting.
                continue;
            }

            const item = this.sellQueue.length > 0 ? this.sellQueue.shift() : this.buyQueue.shift();
            if (item) {
                // The item is now dispatching — its queue wait-timeout must never fire.
                clearTimeout(item.waitTimeout);
                if (this.isPriceEndpoint(item.url)) {
                    this.lastPriceRequestTime = Date.now();
                } else {
                    this.lastTradeRequestTime = Date.now();
                }
                // Fire-and-forget: do NOT await execution here. executeRequest() can run for
                // seconds — the in-band SELL 429 retry loop alone spends up to ~3s in backoff
                // sleeps across SELL_MAX_ATTEMPTS, each followed by another real axios round
                // trip — and this queue is shared by every trade the price-monitor tick
                // evaluates concurrently (see price-monitor.service.ts's Promise.all over
                // PRICE_MONITOR_CONCURRENCY_LIMIT trades). Awaiting it here would stall
                // dispatch of the NEXT queued item — another trade's protective SELL, or any
                // BUY — behind THIS item's full completion, reintroducing cross-trade blocking
                // at the dispatch layer (the exact failure mode FIX A4b's concurrent
                // Promise.all was meant to eliminate). Spacing between dispatches
                // (MIN_DELAY_MS) is still enforced by the elapsed check above using
                // lastTradeRequestTime/lastPriceRequestTime, set synchronously just above, so
                // the next loop iteration still gates correctly on a fresh dispatch clock.
                // executeRequest() always resolves or rejects `item`'s own promise itself and
                // never throws out, so nothing here needs to observe the returned promise --
                // except to decrement its lane's in-flight count once it settles, enforcing
                // MAX_CONCURRENT_INFLIGHT above (per-lane).
                if (item.priority === 'SELL') {
                    this.sellInFlightCount++;
                } else {
                    this.buyInFlightCount++;
                }
                void this.executeRequest(item).finally(() => {
                    if (item.priority === 'SELL') {
                        this.sellInFlightCount--;
                    } else {
                        this.buyInFlightCount--;
                    }
                });
            }
        }

        this.processing = false;
    }

    private static async executeRequest(item: JupiterQueueItem): Promise<void> {
        const maxAttempts = item.priority === 'SELL' ? this.SELL_MAX_ATTEMPTS : 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const response = await this.withExecutionDeadline(
                    item.method === 'GET'
                        ? axios.get(item.url, item.config)
                        : axios.post(item.url, item.data, item.config),
                    item.url,
                );
                item.resolve(response);
                return;
            } catch (error) {
                const isRateLimit = axios.isAxiosError(error) && error.response?.status === 429;

                if (isRateLimit && item.priority === 'BUY') {
                    // BUY is opportunistic: never retry a 429 through this limiter — that
                    // only adds more pressure to an already-throttled endpoint while a
                    // protective SELL might be waiting behind it. Reject immediately; the
                    // existing higher-level retry/backoff in executeJupiterSwap decides
                    // whether the overall BUY attempt gets retried.
                    console.warn(
                        `[JupiterLimiter] BUY rate-limited (429) for ${item.url}. Aborting immediately (no in-limiter retry).`,
                    );
                    item.reject(this.toError(error));
                    return;
                }

                if (isRateLimit && item.priority === 'SELL' && attempt < maxAttempts) {
                    // SELL is protective: retry through the limiter itself rather than
                    // failing the position-management call outright.
                    const delay = attempt * 1000;
                    console.warn(
                        `[JupiterLimiter] SELL rate-limited (429) for ${item.url}. Retrying attempt ${attempt}/${maxAttempts} in ${delay}ms...`,
                    );
                    await new Promise((res) => setTimeout(res, delay));
                    // Reset spacing timer for this item's own endpoint family after the
                    // backoff wait (mirrors the dispatch-time bookkeeping in processQueue).
                    if (this.isPriceEndpoint(item.url)) {
                        this.lastPriceRequestTime = Date.now();
                    } else {
                        this.lastTradeRequestTime = Date.now();
                    }
                    continue;
                }

                const finalError = this.toError(error);
                if (isRateLimit && item.priority === 'SELL') {
                    // Retries exhausted here while STILL rate-limited (attempt === maxAttempts):
                    // this call already spent SELL_MAX_ATTEMPTS's own backoff (~1s+2s). Mark it so
                    // the outer retry/backoff in executeJupiterSwap (trade.service.ts) can avoid
                    // stacking a FULL fresh exponential backoff on top for the SAME rate-limit
                    // event — the two retry layers otherwise compound with no coordination.
                    (finalError as Error & { jupiterSellRetriesExhausted?: boolean }).jupiterSellRetriesExhausted =
                        true;
                }
                item.reject(finalError);
                return;
            }
        }
    }

    /**
     * Backstop execution-level deadline, independent of any `timeout` the caller may (or
     * may not) have passed in `item.config`. Dispatch is fire-and-forget (see processQueue's
     * `void this.executeRequest(item)`), so a hung request with no per-call timeout no longer
     * blocks dispatch of other queued items — but without this deadline it would still hold
     * its own MAX_CONCURRENT_INFLIGHT slot, and leave its caller's promise never settling,
     * forever. This bounds both.
     */
    private static withExecutionDeadline<T>(promise: Promise<T>, url: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(
                    new Error(
                        `[JupiterLimiter] Execution deadline of ${this.EXECUTION_DEADLINE_MS}ms exceeded for ${url}`,
                    ),
                );
            }, this.EXECUTION_DEADLINE_MS);

            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }

    private static toError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    /** Test-only: clears all static queue/state between spec cases. */
    public static resetForTests(): void {
        for (const item of [...this.sellQueue, ...this.buyQueue]) {
            clearTimeout(item.waitTimeout);
        }
        this.sellQueue = [];
        this.buyQueue = [];
        this.processing = false;
        this.lastTradeRequestTime = 0;
        this.lastPriceRequestTime = 0;
        this.sellInFlightCount = 0;
        this.buyInFlightCount = 0;
    }
}
