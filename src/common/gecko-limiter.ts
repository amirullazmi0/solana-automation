import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { getRuntimeNumber } from '../config/runtime-config';

interface QueueItem<T = unknown> {
    url: string;
    resolve: (value: AxiosResponse<T>) => void;
    reject: (reason: Error) => void;
    config?: AxiosRequestConfig;
}

/**
 * Serial request queue for the GeckoTerminal OHLCV API, modelled on `HeliusLimiter`.
 *
 * A separate lane rather than a reuse of `DexLimiter`, for the same reason Helius got its own:
 * `DexLimiter` is one global serial lane sized for DexScreener's budget, so routing chart traffic
 * through it would make every price lookup in the app queue behind candle fetches — and the price
 * lookups are the ones a trade depends on.
 *
 * GeckoTerminal's free tier is roughly 30 requests per minute, and a burst of six consecutive calls
 * was enough to earn a 429 in testing. The default delay is therefore deliberately slow; this is a
 * trickle for a dashboard, never a scanner.
 *
 * No response cache here. The useful cache key is (pool, timeframe) rather than a full URL, so
 * caching lives in `CandleService` — the same split `HeliusLimiter` and `FlowVolumeService` use.
 */
export class GeckoLimiter {
    private static queue: QueueItem[] = [];
    private static processing = false;
    private static lastRequestTime = 0;

    /** Read fresh each iteration so the pacing can be retuned without a rebuild. */
    private static get minDelayMs(): number {
        return getRuntimeNumber('GECKO_MIN_DELAY_MS', 2500);
    }

    public static async get<T = unknown>(
        url: string,
        config?: AxiosRequestConfig,
    ): Promise<AxiosResponse<T>> {
        return new Promise<AxiosResponse<T>>((resolve, reject) => {
            this.queue.push({
                url,
                resolve: resolve as (value: AxiosResponse<unknown>) => void,
                reject,
                config,
            });
            void this.processQueue();
        });
    }

    private static async processQueue(): Promise<void> {
        if (this.processing) return;
        this.processing = true;

        // try/finally so a throw cannot wedge the queue shut for the life of the process.
        try {
            while (this.queue.length > 0) {
                const elapsed = Date.now() - this.lastRequestTime;
                const wait = this.minDelayMs - elapsed;
                if (wait > 0) await new Promise((res) => setTimeout(res, wait));

                const item = this.queue.shift();
                if (!item) continue;

                this.lastRequestTime = Date.now();
                await this.executeRequest(item);
            }
        } finally {
            this.processing = false;
        }
    }

    private static async executeRequest(item: QueueItem, attempt = 1): Promise<void> {
        const retries = 2;
        try {
            const response = await axios.get(item.url, {
                timeout: 15000,
                ...item.config,
                headers: { accept: 'application/json', ...(item.config?.headers ?? {}) },
            });
            item.resolve(response);
        } catch (error) {
            const status = (error as { response?: { status?: number } })?.response?.status;
            if (status === 429 && attempt <= retries) {
                await new Promise((res) => setTimeout(res, attempt * 2000));
                await this.executeRequest(item, attempt + 1);
                return;
            }
            item.reject(error instanceof Error ? error : new Error(String(error)));
        }
    }
}
