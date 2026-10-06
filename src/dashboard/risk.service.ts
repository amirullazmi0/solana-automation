import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { RugCheckApiResponse } from '../dto/analyzer.dto';

interface CacheEntry {
    report?: RugCheckApiResponse;
    failed: boolean;
    expiresAt: number;
}

/**
 * RugCheck reports for the dashboard, cached hard.
 *
 * Its own small queue rather than a shared one, for the reason `GeckoLimiter` exists: the analyzer
 * calls RugCheck on the buy path, and a viewer clicking through coins must never put a request in
 * front of the decision to spend money.
 *
 * The cache window is long on purpose. Mint authority, LP lock state and holder spread are facts
 * about a token that change rarely, so re-asking every minute would spend a budget to receive the
 * same answer. A failure is cached too, briefly, so a page left open on a token RugCheck cannot
 * answer for does not retry forever.
 */
@Injectable()
export class RiskService {
    private readonly logger = new Logger(RiskService.name);
    private readonly cache = new Map<string, CacheEntry>();

    private static readonly TTL_MS = 10 * 60 * 1000;
    private static readonly FAILED_TTL_MS = 60 * 1000;
    private static readonly MIN_DELAY_MS = 1200;

    private chain: Promise<unknown> = Promise.resolve();
    private lastRequestAt = 0;

    async getReport(mint: string): Promise<{ report?: RugCheckApiResponse; failed: boolean }> {
        const cached = this.cache.get(mint);
        if (cached && cached.expiresAt > Date.now()) {
            return { report: cached.report, failed: cached.failed };
        }

        const result = await this.enqueue(() => this.fetch(mint));
        this.cache.set(mint, {
            ...result,
            expiresAt:
                Date.now() + (result.failed ? RiskService.FAILED_TTL_MS : RiskService.TTL_MS),
        });
        this.prune();
        return result;
    }

    /** One at a time, spaced. Chained rather than parallel so bursts cannot stack. */
    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = this.chain.then(async () => {
            const wait = RiskService.MIN_DELAY_MS - (Date.now() - this.lastRequestAt);
            if (wait > 0) await new Promise((res) => setTimeout(res, wait));
            this.lastRequestAt = Date.now();
            return task();
        });
        // The chain must survive a rejected task, or one failure wedges every later request.
        this.chain = run.catch(() => undefined);
        return run;
    }

    private async fetch(mint: string): Promise<{ report?: RugCheckApiResponse; failed: boolean }> {
        try {
            const response = await axios.get<RugCheckApiResponse>(
                `https://api.rugcheck.xyz/v1/tokens/${mint}/report`,
                { timeout: 6000, headers: { accept: 'application/json' } },
            );
            // No body is not a clean bill of health, so it is reported as a failure rather than as
            // an empty-but-present report that would read as "nothing wrong found".
            if (!response.data) return { failed: true };
            return { report: response.data, failed: false };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[Risk] RugCheck failed for ${mint}: ${msg}.`);
            return { failed: true };
        }
    }

    private prune(): void {
        const now = Date.now();
        for (const [k, v] of this.cache.entries()) {
            if (v.expiresAt <= now) this.cache.delete(k);
        }
    }
}
