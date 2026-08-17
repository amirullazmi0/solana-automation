import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { getRuntimeNumber } from '../config/runtime-config';

interface QueueItem<T = unknown> {
    url: string;
    resolve: (value: AxiosResponse<T>) => void;
    reject: (reason: Error) => void;
    config?: AxiosRequestConfig;
}

/**
 * Serial request queue for the Helius Enhanced Transactions API, modelled on `DexLimiter`.
 *
 * Deliberately a separate queue rather than reusing `DexLimiter`: that one is a single global
 * serial lane sized for DexScreener's budget, so routing Helius traffic through it would make
 * every price lookup in the app wait behind flow-volume analysis. Two providers, two lanes.
 *
 * No response cache here — caching is per token mint and lives in `FlowVolumeService`, since the
 * useful cache key is the mint rather than a paginated URL.
 */
export class HeliusLimiter {
    private static queue: QueueItem[] = [];
    private static processing = false;
    private static lastRequestTime = 0;

    private static get minDelayMs(): number {
        return getRuntimeNumber('HELIUS_FLOW_MIN_DELAY_MS', 250);
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

        try {
            while (this.queue.length > 0) {
                const delay = this.minDelayMs;
                const elapsed = Date.now() - this.lastRequestTime;
                if (elapsed < delay) {
                    await new Promise((res) => setTimeout(res, delay - elapsed));
                }

                const item = this.queue.shift();
                if (!item) continue;

                this.lastRequestTime = Date.now();
                await this.executeRequest(item);
            }
        } finally {
            // Without this the queue would wedge permanently if anything above threw.
            this.processing = false;
        }
    }

    private static async executeRequest(item: QueueItem): Promise<void> {
        const retries = 2;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await axios.get(item.url, item.config);
                item.resolve(response);
                return;
            } catch (error) {
                const isRateLimit = axios.isAxiosError(error) && error.response?.status === 429;
                if (isRateLimit && attempt < retries) {
                    await new Promise((res) => setTimeout(res, attempt * 500));
                    this.lastRequestTime = Date.now();
                    continue;
                }
                item.reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
        }
    }
}
