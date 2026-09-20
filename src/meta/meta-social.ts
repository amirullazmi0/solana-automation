import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * How loudly a meta is being talked about somewhere outside this chain.
 *
 * Kept behind an interface because it is the one evidence source that cannot be obtained from data
 * the bot already has. Sightings, volume and boosts come from feeds the scanner polls anyway, and
 * P&L comes from our own ledger; a social signal needs a paid third-party API, a key, a rate-limit
 * budget and an outage story. Isolating it means the other three -- and every gate built on them --
 * work identically whether or not that integration exists.
 *
 * The contract is deliberately minimal: a number per label, higher meaning noisier. It is fed into
 * the heat score as a percentile alongside the others, so the scale is irrelevant as long as it is
 * consistent between labels within one call.
 */
export abstract class MetaSocialSource {
    abstract getMentionVelocity(labels: ReadonlyArray<string>): Promise<Map<string, number>>;
}

/**
 * The implementation used when no external source is configured.
 *
 * Returns nothing rather than zeroes for every label, which matters: an empty map leaves every
 * label tied on the social term, and `percentileRank` scores a universal tie as a neutral 50 for
 * everyone. The term therefore cancels out instead of dragging the whole board down, and the
 * remaining three sources keep their relative weights.
 */
@Injectable()
export class NullMetaSocialSource extends MetaSocialSource {
    async getMentionVelocity(): Promise<Map<string, number>> {
        return new Map();
    }
}

/**
 * Mention velocity from an X/Twitter-compatible recent-search endpoint.
 *
 * Disabled by default and gated on `ENABLE_META_SOCIAL_SOURCE`, because switching it on commits to
 * a paid API tier. Only the hottest few labels are queried per cycle and results are cached for a
 * full poll interval, since the rate limits on these endpoints are far tighter than the rate at
 * which the heat score refreshes.
 */
@Injectable()
export class XMetaSocialSource extends MetaSocialSource {
    private readonly logger = new Logger(XMetaSocialSource.name);
    private cache = new Map<string, number>();
    private cachedAt = 0;

    constructor(private readonly configService: ConfigService) {
        super();
    }

    private get enabled(): boolean {
        return (
            String(this.configService.get('ENABLE_META_SOCIAL_SOURCE', 'false')).toLowerCase() ===
            'true'
        );
    }

    private get pollMs(): number {
        const raw = Number.parseInt(
            this.configService.get<string>('META_SOCIAL_POLL_MS', '900000'),
            10,
        );
        return Number.isFinite(raw) && raw >= 60000 ? raw : 900000;
    }

    private get maxLabels(): number {
        const raw = Number.parseInt(
            this.configService.get<string>('META_SOCIAL_MAX_LABELS', '10'),
            10,
        );
        return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50) : 10;
    }

    async getMentionVelocity(labels: ReadonlyArray<string>): Promise<Map<string, number>> {
        if (!this.enabled) return new Map();

        const token = this.configService.get<string>('X_BEARER_TOKEN');
        if (!token) {
            this.logger.warn('[Meta] Social source enabled but X_BEARER_TOKEN is unset.');
            return new Map();
        }

        if (Date.now() - this.cachedAt < this.pollMs) return this.cache;

        const wanted = labels.slice(0, this.maxLabels);
        const counts = new Map<string, number>();

        for (const label of wanted) {
            try {
                const count = await this.countRecentMentions(label, token);
                if (count !== undefined) counts.set(label, count);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                // One label failing must not blank the others: a partial map still ranks the
                // labels it covers, and absent ones fall back to a neutral percentile.
                this.logger.warn(`[Meta] Social lookup failed for ${label}: ${msg}.`);
            }
        }

        this.cache = counts;
        this.cachedAt = Date.now();
        return counts;
    }

    private async countRecentMentions(label: string, token: string): Promise<number | undefined> {
        const axios = (await import('axios')).default;
        const query = `${label.replace(/-/g, ' ')} (solana OR memecoin OR pumpfun) -is:retweet`;
        const response = await axios.get<{ meta?: { total_tweet_count?: number } }>(
            'https://api.x.com/2/tweets/counts/recent',
            {
                params: { query, granularity: 'day' },
                headers: { Authorization: `Bearer ${token}` },
                timeout: 8000,
            },
        );
        return response.data?.meta?.total_tweet_count;
    }
}
