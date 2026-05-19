import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

interface QueueItem<T = unknown> {
    url: string;
    resolve: (value: AxiosResponse<T>) => void;
    reject: (reason: Error) => void;
    config?: AxiosRequestConfig;
}

interface CacheEntry<T = unknown> {
    response: AxiosResponse<T>;
    expiresAt: number;
}

export class DexLimiter {
    private static queue: QueueItem[] = [];
    private static processing = false;
    private static lastRequestTime = 0;
    private static readonly MIN_DELAY_MS = 500; // Jeda minimal 500ms antar request

    // Cache penyimpanan RAM
    private static cache = new Map<string, CacheEntry>();

    public static async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
        // 1. Bersihkan cache yang kedaluwarsa secara berkala
        this.cleanExpiredCache();

        // 2. Cek apakah ada di cache dan belum expired
        const cached = this.cache.get(url);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.response as AxiosResponse<T>;
        }

        // 3. Masukkan ke antrean jika tidak ada cache
        return new Promise<AxiosResponse<T>>((resolve, reject) => {
            this.queue.push({
                url,
                resolve: resolve as (value: AxiosResponse<unknown>) => void,
                reject,
                config
            });
            this.processQueue();
        });
    }

    private static getTTLForUrl(url: string): number {
        if (url.includes('token-boosts') || url.includes('token-profiles')) {
            return 15000; // 15 detik untuk discovery polling
        }
        return 5000; // 5 detik untuk detail token (harga, likuiditas)
    }

    private static cleanExpiredCache(): void {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (value.expiresAt <= now) {
                this.cache.delete(key);
            }
        }
    }

    private static async processQueue(): Promise<void> {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const now = Date.now();
            const elapsed = now - this.lastRequestTime;
            if (elapsed < this.MIN_DELAY_MS) {
                const wait = this.MIN_DELAY_MS - elapsed;
                await new Promise((res) => setTimeout(res, wait));
            }

            const item = this.queue.shift();
            if (item) {
                // Double check cache right before executing (in case another identical request resolved while this was in queue)
                const cached = this.cache.get(item.url);
                if (cached && cached.expiresAt > Date.now()) {
                    item.resolve(cached.response);
                    continue;
                }

                this.lastRequestTime = Date.now();
                await this.executeRequest(item);
            }
        }

        this.processing = false;
    }

    private static async executeRequest(item: QueueItem): Promise<void> {
        const retries = 3;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await axios.get(item.url, item.config);
                
                // Simpan ke cache jika sukses
                const ttl = this.getTTLForUrl(item.url);
                this.cache.set(item.url, {
                    response,
                    expiresAt: Date.now() + ttl
                });

                item.resolve(response);
                return;
            } catch (error) {
                const isRateLimit = axios.isAxiosError(error) && error.response?.status === 429;
                if (isRateLimit && attempt < retries) {
                    const delay = attempt * 1000;
                    console.warn(`[DexLimiter] Rate limited (429) for ${item.url}. Retrying attempt ${attempt}/${retries} in ${delay}ms...`);
                    await new Promise((res) => setTimeout(res, delay));
                    this.lastRequestTime = Date.now(); // Reset timer
                    continue;
                }
                const err = error instanceof Error ? error : new Error(String(error));
                item.reject(err);
                return;
            }
        }
    }
}
