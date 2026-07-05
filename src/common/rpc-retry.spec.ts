import {
    classifyRpcError,
    isRetryableRpcError,
    isAmbiguousSendFailure,
    computeBackoffDelay,
    RpcEndpointPool,
    parseRpcEndpoints,
    withRpcRetry,
} from './rpc-retry';

describe('isAmbiguousSendFailure', () => {
    it('treats a preflight/simulation failure as definitively pre-broadcast (NOT ambiguous)', () => {
        expect(
            isAmbiguousSendFailure(
                new Error('Transaction simulation failed: Blockhash not found'),
            ),
        ).toBe(false);
        expect(
            isAmbiguousSendFailure(
                new Error('failed to send transaction: Transaction simulation failed'),
            ),
        ).toBe(false);
        expect(
            isAmbiguousSendFailure(new Error('Error processing Instruction 0: custom program error: 0x1')),
        ).toBe(false);
    });
    it('treats expired blockhash / block height exceeded as pre-broadcast', () => {
        expect(isAmbiguousSendFailure(new Error('block height exceeded'))).toBe(false);
        expect(isAmbiguousSendFailure(new Error('Blockhash not found'))).toBe(false);
    });
    it('treats a 429 rate-limit as pre-broadcast (provider refused the request)', () => {
        expect(isAmbiguousSendFailure({ response: { status: 429 } })).toBe(false);
        expect(isAmbiguousSendFailure(new Error('429 Too Many Requests'))).toBe(false);
    });
    it('treats a transport timeout as AMBIGUOUS (may have reached the leader)', () => {
        expect(isAmbiguousSendFailure({ code: 'ECONNABORTED' })).toBe(true);
        expect(isAmbiguousSendFailure({ code: 'ETIMEDOUT' })).toBe(true);
        expect(isAmbiguousSendFailure(new Error('socket hang up timeout'))).toBe(true);
    });
    it('treats a 5xx / connection reset as AMBIGUOUS', () => {
        expect(isAmbiguousSendFailure({ response: { status: 503 } })).toBe(true);
        expect(isAmbiguousSendFailure({ code: 'ECONNRESET' })).toBe(true);
    });
    it('treats a clean structured (OTHER-class) rejection as pre-broadcast', () => {
        expect(isAmbiguousSendFailure({ code: 'SOME_RPC_REJECT', message: 'bad request' })).toBe(
            false,
        );
    });
    it('prefers the pre-broadcast verdict even if the message contains 5xx-looking digits', () => {
        // A simulation log line that coincidentally contains "503" must not be
        // reclassified as an ambiguous SERVER failure.
        expect(
            isAmbiguousSendFailure(new Error('Transaction simulation failed: consumed 503 units')),
        ).toBe(false);
    });
});

describe('classifyRpcError', () => {
    it('classifies axios 429 as RATE_LIMIT', () => {
        expect(classifyRpcError({ response: { status: 429 } })).toBe('RATE_LIMIT');
    });
    it('classifies message-only 429 as RATE_LIMIT', () => {
        expect(classifyRpcError(new Error('Server responded with 429 Too Many Requests'))).toBe(
            'RATE_LIMIT',
        );
    });
    it('classifies 5xx as SERVER', () => {
        expect(classifyRpcError({ response: { status: 503 } })).toBe('SERVER');
        expect(classifyRpcError(new Error('failed: 502 Bad Gateway'))).toBe('SERVER');
    });
    it('classifies ECONNABORTED as TIMEOUT', () => {
        expect(classifyRpcError({ code: 'ECONNABORTED', message: 'timeout of 20000ms' })).toBe(
            'TIMEOUT',
        );
    });
    it('classifies network resets as retryable SERVER-tier', () => {
        expect(classifyRpcError({ code: 'ECONNRESET' })).toBe('SERVER');
    });
    it('classifies a plain business error as OTHER (non-retryable)', () => {
        expect(classifyRpcError(new Error('PRICE_IMPACT_GUARD'))).toBe('OTHER');
        expect(isRetryableRpcError(new Error('PRICE_IMPACT_GUARD'))).toBe(false);
    });
    it('marks 429/5xx/timeout as retryable', () => {
        expect(isRetryableRpcError({ response: { status: 429 } })).toBe(true);
        expect(isRetryableRpcError({ response: { status: 500 } })).toBe(true);
        expect(isRetryableRpcError({ code: 'ETIMEDOUT' })).toBe(true);
    });
});

describe('computeBackoffDelay', () => {
    it('grows exponentially from base with zero jitter', () => {
        const opts = { baseMs: 1000, maxMs: 100000, jitterRatio: 0 };
        expect(computeBackoffDelay(0, opts, () => 0.5)).toBe(1000);
        expect(computeBackoffDelay(1, opts, () => 0.5)).toBe(2000);
        expect(computeBackoffDelay(2, opts, () => 0.5)).toBe(4000);
        expect(computeBackoffDelay(3, opts, () => 0.5)).toBe(8000);
    });
    it('never exceeds maxMs even with max positive jitter', () => {
        const opts = { baseMs: 1000, maxMs: 5000, jitterRatio: 0.5 };
        for (let attempt = 0; attempt < 12; attempt++) {
            expect(computeBackoffDelay(attempt, opts, () => 1)).toBeLessThanOrEqual(5000);
        }
    });
    it('never returns a negative delay with max negative jitter', () => {
        const opts = { baseMs: 1000, maxMs: 5000, jitterRatio: 0.9 };
        for (let attempt = 0; attempt < 12; attempt++) {
            expect(computeBackoffDelay(attempt, opts, () => 0)).toBeGreaterThanOrEqual(0);
        }
    });
    it('applies symmetric jitter around the base delay', () => {
        const opts = { baseMs: 1000, maxMs: 100000, jitterRatio: 0.5 };
        // rng=1 -> +50%, rng=0 -> -50%
        expect(computeBackoffDelay(0, opts, () => 1)).toBe(1500);
        expect(computeBackoffDelay(0, opts, () => 0)).toBe(500);
    });
});

describe('RpcEndpointPool', () => {
    it('dedups and drops empty endpoints, preserving order', () => {
        const pool = new RpcEndpointPool(['  a ', '', 'b', 'a', null, undefined, 'c']);
        expect(pool.endpoints()).toEqual(['a', 'b', 'c']);
        expect(pool.size).toBe(3);
        expect(pool.current).toBe('a');
    });
    it('rotates round-robin', () => {
        const pool = new RpcEndpointPool(['a', 'b', 'c']);
        expect(pool.rotate()).toBe('b');
        expect(pool.rotate()).toBe('c');
        expect(pool.rotate()).toBe('a');
    });
    it('stays put when only one endpoint is configured', () => {
        const pool = new RpcEndpointPool(['only']);
        expect(pool.rotate()).toBe('only');
        expect(pool.current).toBe('only');
    });
    it('throws when no usable endpoint is supplied', () => {
        expect(() => new RpcEndpointPool(['', '   ', null])).toThrow();
    });
});

describe('parseRpcEndpoints', () => {
    it('orders primary, secondary, csv fallbacks, then hardcoded', () => {
        const list = parseRpcEndpoints('P', 'S', 'F1, F2  F3', 'PUB');
        expect(list).toEqual(['P', 'S', 'F1', 'F2', 'F3', 'PUB']);
    });
    it('keeps the primary first even when others are empty', () => {
        const list = parseRpcEndpoints('P', '', '', 'PUB');
        const pool = new RpcEndpointPool(list);
        expect(pool.current).toBe('P');
        expect(pool.endpoints()).toEqual(['P', 'PUB']);
    });
});

describe('withRpcRetry', () => {
    const noSleep = () => Promise.resolve();

    it('returns immediately on first success', async () => {
        const fn = jest.fn().mockResolvedValue('ok');
        const out = await withRpcRetry(fn, { maxAttempts: 5, sleep: noSleep });
        expect(out).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries a 429 then succeeds (mocked RPC)', async () => {
        const fn = jest
            .fn()
            .mockRejectedValueOnce({ response: { status: 429 } })
            .mockRejectedValueOnce({ response: { status: 429 } })
            .mockResolvedValue('landed');
        const out = await withRpcRetry(fn, { maxAttempts: 5, sleep: noSleep, rng: () => 0.5 });
        expect(out).toBe('landed');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('rotates the endpoint on each rate-limit before retrying', async () => {
        const pool = new RpcEndpointPool(['a', 'b', 'c']);
        const rotate = jest.fn((): void => {
            pool.rotate();
        });
        const fn = jest
            .fn()
            .mockRejectedValueOnce({ response: { status: 429 } })
            .mockResolvedValue('ok');
        await withRpcRetry(fn, {
            maxAttempts: 3,
            sleep: noSleep,
            onRateLimit: rotate,
        });
        expect(rotate).toHaveBeenCalledTimes(1);
        expect(pool.current).toBe('b');
    });

    it('does NOT retry a non-retryable business error', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('PRICE_IMPACT_GUARD'));
        await expect(
            withRpcRetry(fn, { maxAttempts: 5, sleep: noSleep }),
        ).rejects.toThrow('PRICE_IMPACT_GUARD');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('IDEMPOTENCY: aborts retry when isSafeToRetry returns false (prevents double-sell)', async () => {
        const fn = jest.fn().mockRejectedValue({ response: { status: 429 } });
        // Position no longer safe to re-submit against (e.g. balance already 0).
        const isSafeToRetry = jest.fn().mockResolvedValue(false);
        const onExhausted = jest.fn();
        await expect(
            withRpcRetry(fn, {
                maxAttempts: 5,
                sleep: noSleep,
                isSafeToRetry,
                onExhausted,
            }),
        ).rejects.toBeDefined();
        // Only the first attempt ran; the guard blocked all re-submits.
        expect(fn).toHaveBeenCalledTimes(1);
        expect(isSafeToRetry).toHaveBeenCalledTimes(1);
        expect(onExhausted).toHaveBeenCalledTimes(1);
    });

    it('keeps retrying while isSafeToRetry stays true', async () => {
        const fn = jest
            .fn()
            .mockRejectedValueOnce({ response: { status: 500 } })
            .mockResolvedValue('ok');
        const isSafeToRetry = jest.fn().mockResolvedValue(true);
        const out = await withRpcRetry(fn, {
            maxAttempts: 3,
            sleep: noSleep,
            isSafeToRetry,
        });
        expect(out).toBe('ok');
        expect(isSafeToRetry).toHaveBeenCalledTimes(1);
    });

    it('exhausts the budget and calls onExhausted, then throws the last error', async () => {
        const err = { response: { status: 503 }, message: '503 x' };
        const fn = jest.fn().mockRejectedValue(err);
        const onExhausted = jest.fn();
        await expect(
            withRpcRetry(fn, { maxAttempts: 3, sleep: noSleep, onExhausted }),
        ).rejects.toBe(err);
        expect(fn).toHaveBeenCalledTimes(3);
        expect(onExhausted).toHaveBeenCalledWith(err, 3);
    });

    it('passes the 0-based attempt index to the operation', async () => {
        const seen: number[] = [];
        const fn = jest.fn(async (attempt: number) => {
            seen.push(attempt);
            if (attempt < 2) throw { response: { status: 429 } };
            return 'ok';
        });
        await withRpcRetry(fn, { maxAttempts: 5, sleep: noSleep });
        expect(seen).toEqual([0, 1, 2]);
    });
});
