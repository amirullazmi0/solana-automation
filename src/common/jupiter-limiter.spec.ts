import axios from 'axios';
import { JupiterLimiter } from './jupiter-limiter';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('JupiterLimiter', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        JupiterLimiter.resetForTests();
        jest.clearAllMocks();
        // isAxiosError is a type-guard function on the real axios module; keep it real
        // behavior here (checking the shape) rather than an auto-mocked stub.
        mockedAxios.isAxiosError.mockImplementation(
            (error: unknown): error is import('axios').AxiosError =>
                typeof error === 'object' && error !== null && 'response' in error,
        );
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('always dispatches a SELL request before a BUY request queued around the same time', async () => {
        mockedAxios.get.mockImplementation(async (url: string) => ({
            data: { url },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: {} as never,
        }));

        const buyPromise = JupiterLimiter.get('https://api.jup.ag/buy', 'BUY');
        const sellPromise = JupiterLimiter.get('https://api.jup.ag/sell', 'SELL');

        await jest.runAllTimersAsync();
        await Promise.all([buyPromise, sellPromise]);

        expect(mockedAxios.get).toHaveBeenCalledTimes(2);
        expect(mockedAxios.get.mock.calls[0][0]).toBe('https://api.jup.ag/sell');
        expect(mockedAxios.get.mock.calls[1][0]).toBe('https://api.jup.ag/buy');
    });

    it('aborts a BUY request immediately on a 429 (no in-limiter retry)', async () => {
        const rateLimitError = { response: { status: 429 }, isAxiosError: true };
        mockedAxios.get.mockRejectedValue(rateLimitError);

        const buyPromise = JupiterLimiter.get('https://api.jup.ag/buy', 'BUY');
        // Attach the rejection assertion BEFORE flushing timers so the rejection is never
        // briefly unhandled (which Node/Jest would otherwise report as a crash unrelated to
        // the actual assertion below).
        const assertion = expect(buyPromise).rejects.toThrow();
        await jest.runAllTimersAsync();
        await assertion;

        // Exactly one attempt: BUY must not be retried through the limiter.
        expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('retries a SELL request through the limiter on a 429 and eventually succeeds', async () => {
        const rateLimitError = { response: { status: 429 }, isAxiosError: true };
        const successResponse = {
            data: { ok: true },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: {} as never,
        };
        mockedAxios.get
            .mockRejectedValueOnce(rateLimitError)
            .mockRejectedValueOnce(rateLimitError)
            .mockResolvedValueOnce(successResponse as never);

        const sellPromise = JupiterLimiter.get('https://api.jup.ag/sell', 'SELL');
        await jest.runAllTimersAsync();

        const result = await sellPromise;
        expect(result.data).toEqual({ ok: true });
        // Two failed attempts (rate-limited) + one successful attempt = 3 calls.
        expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });

    it('gives up a SELL request after exhausting its retry budget on repeated 429s', async () => {
        const rateLimitError = { response: { status: 429 }, isAxiosError: true };
        mockedAxios.get.mockRejectedValue(rateLimitError);

        const sellPromise = JupiterLimiter.get('https://api.jup.ag/sell', 'SELL');
        const assertion = expect(sellPromise).rejects.toThrow();
        await jest.runAllTimersAsync();
        await assertion;

        // SELL_MAX_ATTEMPTS = 3
        expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });

    it('supports POST requests (swap-build call)', async () => {
        const successResponse = {
            data: { swapTransaction: 'abc123' },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: {} as never,
        };
        mockedAxios.post.mockResolvedValue(successResponse as never);

        const postPromise = JupiterLimiter.post(
            'https://api.jup.ag/swap/v1/swap',
            { foo: 'bar' },
            'SELL',
        );
        await jest.runAllTimersAsync();

        const result = await postPromise;
        expect(result.data).toEqual({ swapTransaction: 'abc123' });
        expect(mockedAxios.post).toHaveBeenCalledWith(
            'https://api.jup.ag/swap/v1/swap',
            { foo: 'bar' },
            undefined,
        );
    });

    it('does not retry a BUY or SELL request on a non-429 error', async () => {
        const serverError = { response: { status: 500 }, isAxiosError: true };
        mockedAxios.get.mockRejectedValue(serverError);

        const sellPromise = JupiterLimiter.get('https://api.jup.ag/sell', 'SELL');
        const assertion = expect(sellPromise).rejects.toThrow();
        await jest.runAllTimersAsync();
        await assertion;

        expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('eventually rejects a BUY request starved behind a long run of SELL requests, instead of hanging forever', async () => {
        // A never-resolving response means none of these SELLs ever free up "capacity" by
        // completing, but under the fixed dispatch loop that no longer matters: dispatch
        // itself (shift + fire-and-forget) doesn't wait on completion, so the SELL lane
        // keeps draining every MIN_DELAY_MS (500ms) regardless. Queue enough SELLs (60 *
        // 500ms = 30s of dispatch time) that the queued BUY is still sitting behind the
        // SELL lane — never reaching the front — when its own 15s queue wait-timeout
        // budget expires. It must still settle (reject) at that point, rather than hang
        // forever.
        mockedAxios.get.mockImplementation(() => new Promise<never>(() => {}));

        const buyPromise = JupiterLimiter.get('https://api.jup.ag/buy', 'BUY');
        // Attach the rejection assertion before flushing timers to avoid an unhandled
        // rejection window.
        const assertion = expect(buyPromise).rejects.toThrow(/timed out/);
        for (let i = 0; i < 60; i++) {
            JupiterLimiter.get(`https://api.jup.ag/sell${i}`, 'SELL').catch(() => {});
        }

        // Past the BUY queue wait-timeout budget (15s), but still well within the SELL
        // lane's dispatch run (60 items * 500ms spacing = 30s).
        await jest.advanceTimersByTimeAsync(20_000);

        await assertion;
    });

    it('dispatches a second queued SELL without waiting for the first SELL to finish its in-band 429 retry backoff', async () => {
        // Regression test for the cross-trade blocking bug: two SELLs queued together (as
        // would happen when the price-monitor tick evaluates two trades concurrently, each
        // issuing a protective SELL). The first SELL is rate-limited and enters its 1s
        // in-band retry backoff (see SELL_MAX_ATTEMPTS handling in executeRequest). The
        // second SELL must still be dispatched once the MIN_DELAY_MS spacing gate elapses,
        // rather than waiting for the first SELL's full retry sequence to complete.
        const rateLimitError = { response: { status: 429 }, isAxiosError: true };
        const successResponse = (url: string) => ({
            data: { url },
            status: 200,
            statusText: 'OK',
            headers: {},
            config: {} as never,
        });

        let sellAAttempts = 0;
        mockedAxios.get.mockImplementation(async (url: string) => {
            if (url === 'https://api.jup.ag/sellA') {
                sellAAttempts++;
                if (sellAAttempts === 1) throw rateLimitError;
                return successResponse(url);
            }
            return successResponse(url);
        });

        const sellAPromise = JupiterLimiter.get('https://api.jup.ag/sellA', 'SELL');
        const sellBPromise = JupiterLimiter.get('https://api.jup.ag/sellB', 'SELL');

        // Flush the initial same-tick yield inside processQueue: sellA is dispatched
        // (its first, rate-limited attempt) and immediately begins its 1000ms backoff.
        await jest.advanceTimersByTimeAsync(0);
        expect(mockedAxios.get).toHaveBeenCalledTimes(1);
        expect(mockedAxios.get.mock.calls[0][0]).toBe('https://api.jup.ag/sellA');

        // Advance only past the MIN_DELAY_MS spacing gate (500ms) — well short of sellA's
        // 1000ms backoff. Under the bug, sellB would still be stuck waiting behind sellA's
        // full executeRequest() call; fixed, it dispatches as soon as spacing allows.
        await jest.advanceTimersByTimeAsync(500);
        expect(mockedAxios.get).toHaveBeenCalledTimes(2);
        expect(mockedAxios.get.mock.calls[1][0]).toBe('https://api.jup.ag/sellB');

        await jest.runAllTimersAsync();
        const [resultA, resultB] = await Promise.all([sellAPromise, sellBPromise]);
        expect(resultA.data).toEqual({ url: 'https://api.jup.ag/sellA' });
        expect(resultB.data).toEqual({ url: 'https://api.jup.ag/sellB' });
        // sellA: attempt 1 (429) + attempt 2 (success); sellB: attempt 1 (success).
        expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });

    it('caps concurrent in-flight dispatches at MAX_CONCURRENT_INFLIGHT within a single lane', async () => {
        // Requests that never resolve so each dispatch permanently occupies an in-flight
        // slot, isolating the MAX_CONCURRENT_INFLIGHT gate itself (as opposed to the
        // queue-wait-timeout behavior covered by the "eventually rejects a BUY..." test).
        mockedAxios.get.mockImplementation(() => new Promise<never>(() => {}));

        // Enqueue one more than the cap (MAX_CONCURRENT_INFLIGHT = 20) in the same (BUY) lane.
        for (let i = 0; i < 21; i++) {
            JupiterLimiter.get(`https://api.jup.ag/buy${i}`, 'BUY').catch(() => {});
        }

        // Let all 20 permitted dispatches clear their MIN_DELAY_MS (500ms) spacing gates.
        await jest.advanceTimersByTimeAsync(20 * 500);
        expect(mockedAxios.get).toHaveBeenCalledTimes(20);

        // The 21st is spacing-eligible well before its own 15s queue-wait-timeout, but must
        // still be held back by the in-flight cap, since none of the first 20 ever settle.
        await jest.advanceTimersByTimeAsync(4_000);
        expect(mockedAxios.get).toHaveBeenCalledTimes(20);
    });

    it('dispatches a SELL immediately even when the BUY lane has saturated the concurrency cap (priority-inversion regression)', async () => {
        // Regression test for the shared-counter priority-inversion bug: with a single
        // combined in-flight counter, 20 in-flight BUYs would hold every MAX_CONCURRENT_INFLIGHT
        // slot and block a SELL sitting at the front of sellQueue from ever dispatching,
        // violating the "SELL always drains before BUY" invariant. With per-lane counters,
        // the BUY lane saturating its own cap must never hold back the SELL lane.
        mockedAxios.get.mockImplementation((url: string) => {
            if (url.startsWith('https://api.jup.ag/buy')) {
                // Never resolves: these 20 BUYs permanently occupy in-flight slots.
                return new Promise<never>(() => {});
            }
            return Promise.resolve({
                data: { url },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {} as never,
            });
        });

        // Saturate the BUY lane's concurrency cap (MAX_CONCURRENT_INFLIGHT = 20).
        for (let i = 0; i < 20; i++) {
            JupiterLimiter.get(`https://api.jup.ag/buy${i}`, 'BUY').catch(() => {});
        }
        await jest.advanceTimersByTimeAsync(20 * 500);
        expect(mockedAxios.get).toHaveBeenCalledTimes(20);

        // Now enqueue a SELL: it must dispatch on the very next spacing tick, not wait for a
        // BUY in-flight slot to free (which never happens in this test).
        const sellPromise = JupiterLimiter.get('https://api.jup.ag/sell', 'SELL');
        await jest.advanceTimersByTimeAsync(500);

        expect(mockedAxios.get).toHaveBeenCalledTimes(21);
        expect(mockedAxios.get.mock.calls[20][0]).toBe('https://api.jup.ag/sell');

        await expect(sellPromise).resolves.toMatchObject({ data: { url: 'https://api.jup.ag/sell' } });
    });
});
