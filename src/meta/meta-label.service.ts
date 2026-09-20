import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIService } from '../ai/ai.service';
import { PrismaService } from '../prisma/prisma.service';
import {
    MetaLabelRecord,
    MetaLabelRequest,
    UNLABELED,
    extractNewLabels,
    shouldRefreshLabel,
} from './meta-label';

/**
 * Owns the meta label for a mint: when to ask the model, how many questions to allow, and how to
 * answer callers without ever blocking them.
 *
 * Three constraints shape this, and all three are about money rather than correctness:
 *
 *   - `processNewToken` re-analyses one mint roughly once a second for up to twelve minutes, so a
 *     naive implementation fires several hundred identical requests for a single token. The cache,
 *     the pending set and the permanent persistence exist to make that exactly one request, ever.
 *   - Labelling is batched. A single mint is never worth a request on its own, so requests collect
 *     in a buffer and leave either when the buffer fills or when the timer fires, whichever first.
 *   - Spend must be knowable in advance. An hourly request ceiling caps the bill no matter what the
 *     scanner throughput does, and hitting it degrades to "no label", which scores zero rather than
 *     guessing.
 *
 * Callers never await any of this. `getLabel` is a synchronous cache read that returns undefined
 * until an answer exists, and a candidate with no label is simply not given a meta adjustment.
 */
@Injectable()
export class MetaLabelService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(MetaLabelService.name);

    /** Answers, keyed by mint. Never expires: a token's name does not change. */
    private readonly cache = new Map<string, MetaLabelRecord>();
    /** Mints already queued or being read from the DB, so work is never started twice. */
    private readonly pending = new Set<string>();
    private buffer: MetaLabelRequest[] = [];

    private vocabulary = new Set<string>();
    private aliases = new Map<string, string>();
    private vocabularyLoaded = false;

    private flushTimer?: NodeJS.Timeout;
    private flushing = false;

    private hourStartedAt = Date.now();
    private requestsThisHour = 0;
    private minuteStartedAt = Date.now();
    private populationThisMinute = 0;

    /** Running spend accounting, surfaced in the meta report so cost is observed, not estimated. */
    private readonly usage = { requests: 0, promptTokens: 0, completionTokens: 0, mints: 0 };

    constructor(
        private readonly configService: ConfigService,
        private readonly aiService: AIService,
        private readonly prismaService: PrismaService,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.loadVocabulary();
        this.flushTimer = setInterval(() => {
            void this.flush().catch(() => undefined);
        }, this.batchIntervalMs);
        this.flushTimer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.flushTimer) clearInterval(this.flushTimer);
    }

    private get batchSize(): number {
        return this.readInt('META_LABEL_BATCH_SIZE', 40, 1, 200);
    }

    private get batchIntervalMs(): number {
        return this.readInt('META_LABEL_BATCH_INTERVAL_MS', 20000, 2000, 600000);
    }

    private get maxRequestsPerHour(): number {
        return this.readInt('META_LABEL_MAX_PER_HOUR', 120, 0, 10000);
    }

    private get populationSamplePerMinute(): number {
        return this.readInt('META_POPULATION_SAMPLE_PER_MIN', 20, 0, 1000);
    }

    private readInt(key: string, fallback: number, min: number, max: number): number {
        const raw = Number.parseInt(this.configService.get<string>(key, String(fallback)), 10);
        if (!Number.isFinite(raw)) return fallback;
        return Math.max(min, Math.min(max, raw));
    }

    /**
     * Synchronous read. Undefined means "not decided yet", which callers must treat as no opinion
     * rather than as a weak or absent theme.
     */
    getLabel(tokenMint: string): string | undefined {
        const record = this.cache.get(tokenMint);
        if (!record) return undefined;
        return record.label === UNLABELED ? undefined : record.label;
    }

    getRecord(tokenMint: string): MetaLabelRecord | undefined {
        return this.cache.get(tokenMint);
    }

    getUsageSnapshot(): { requests: number; promptTokens: number; completionTokens: number; mints: number } {
        return { ...this.usage };
    }

    getVocabulary(): string[] {
        return [...this.vocabulary];
    }

    /**
     * Fire-and-forget request for a label. Returns immediately in every case.
     *
     * `population` marks a token that failed the traction gates and will never be bought. Those are
     * still worth labelling, because the heat score has to know what the whole market is doing and
     * not merely what our own filters let through -- but they are rate-limited separately, since
     * they are pure measurement and must not crowd out labelling of actual candidates.
     */
    scheduleLabel(request: MetaLabelRequest, options: { population?: boolean } = {}): void {
        const tokenMint = String(request.tokenMint ?? '').trim();
        const tokenName = String(request.tokenName ?? '').trim();
        if (!tokenMint || !tokenName) return;
        if (this.cache.has(tokenMint) || this.pending.has(tokenMint)) return;

        if (options.population && !this.consumePopulationSlot()) return;

        this.pending.add(tokenMint);
        void this.enqueue({ tokenMint, tokenName, symbol: request.symbol }).catch(() => {
            this.pending.delete(tokenMint);
        });
    }

    /** Per-minute allowance for measurement-only labelling. */
    private consumePopulationSlot(): boolean {
        const now = Date.now();
        if (now - this.minuteStartedAt >= 60_000) {
            this.minuteStartedAt = now;
            this.populationThisMinute = 0;
        }
        if (this.populationThisMinute >= this.populationSamplePerMinute) return false;
        this.populationThisMinute += 1;
        return true;
    }

    private async enqueue(request: MetaLabelRequest): Promise<void> {
        const persisted = await this.readPersisted(request.tokenMint);
        if (!shouldRefreshLabel(persisted)) {
            this.cache.set(request.tokenMint, persisted as MetaLabelRecord);
            this.pending.delete(request.tokenMint);
            return;
        }

        this.buffer.push(request);
        if (this.buffer.length >= this.batchSize) {
            void this.flush().catch(() => undefined);
        }
    }

    /**
     * Sends one batch.
     *
     * Guarded against re-entry because both the timer and a full buffer can trigger it, and two
     * concurrent flushes would send overlapping batches and pay for the same mints twice.
     */
    private async flush(): Promise<void> {
        if (this.flushing) return;
        if (this.buffer.length === 0) return;
        if (!this.consumeRequestBudget()) {
            // Drop the buffer rather than hold it: these mints re-enter on the next sighting, and a
            // buffer kept across a throttled hour would flush a stale, oversized batch later.
            const dropped = this.buffer.splice(0, this.buffer.length);
            for (const item of dropped) this.pending.delete(item.tokenMint);
            return;
        }

        this.flushing = true;
        const batch = this.buffer.splice(0, this.batchSize);

        try {
            if (!this.vocabularyLoaded) await this.loadVocabulary();

            const result = await this.aiService.labelMetas(
                batch,
                [...this.vocabulary],
                this.aliases,
            );

            // A null result is an outage, not a verdict. Nothing is cached or persisted, so these
            // mints are simply asked again the next time they are seen.
            if (!result) {
                for (const item of batch) this.pending.delete(item.tokenMint);
                return;
            }

            const records = result.records;
            this.usage.requests += 1;
            this.usage.mints += records.length;
            this.usage.promptTokens += result.promptTokens;
            this.usage.completionTokens += result.completionTokens;

            for (const record of records) {
                this.cache.set(record.tokenMint, record);
                this.pending.delete(record.tokenMint);
            }

            await this.persist(records, batch);
            await this.growVocabulary(records);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[Meta] Flush of ${batch.length} failed: ${msg}.`);
            for (const item of batch) this.pending.delete(item.tokenMint);
        } finally {
            this.flushing = false;
        }
    }

    /** Hard ceiling on spend. Rolls over on the hour rather than on a sliding window, so the worst
     * case is exactly `maxRequestsPerHour` requests times the model price. */
    private consumeRequestBudget(): boolean {
        const now = Date.now();
        if (now - this.hourStartedAt >= 3_600_000) {
            this.hourStartedAt = now;
            this.requestsThisHour = 0;
        }
        if (this.requestsThisHour >= this.maxRequestsPerHour) {
            this.logger.warn(
                `[Meta] Hourly label budget of ${this.maxRequestsPerHour} reached; ` +
                    'labelling paused until the next hour.',
            );
            return false;
        }
        this.requestsThisHour += 1;
        return true;
    }

    private async readPersisted(tokenMint: string): Promise<MetaLabelRecord | undefined> {
        try {
            const row = await this.prismaService.tokenMetaLabel.findUnique({ where: { tokenMint } });
            if (!row) return undefined;
            return {
                tokenMint: row.tokenMint,
                label: row.label,
                confidence: (row.confidence ?? 'low') as MetaLabelRecord['confidence'],
                source: (row.source ?? 'llm') as MetaLabelRecord['source'],
                labeledAt: row.labeledAt.getTime(),
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[Meta] Read failed for ${tokenMint}: ${msg}.`);
            return undefined;
        }
    }

    private async persist(
        records: ReadonlyArray<MetaLabelRecord>,
        batch: ReadonlyArray<MetaLabelRequest>,
    ): Promise<void> {
        const names = new Map(batch.map((item) => [item.tokenMint, item]));
        for (const record of records) {
            try {
                const source = names.get(record.tokenMint);
                const data = {
                    label: record.label,
                    tokenName: source?.tokenName ?? null,
                    symbol: source?.symbol ?? null,
                    confidence: record.confidence,
                    source: record.source,
                    labeledAt: new Date(record.labeledAt),
                };
                await this.prismaService.tokenMetaLabel.upsert({
                    where: { tokenMint: record.tokenMint },
                    update: data,
                    create: { tokenMint: record.tokenMint, ...data },
                });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                // The in-memory copy is already set, so a DB failure only costs persistence across
                // a restart -- never a second charge within this process lifetime.
                this.logger.warn(`[Meta] Persist failed for ${record.tokenMint}: ${msg}.`);
            }
        }
    }

    private async loadVocabulary(): Promise<void> {
        try {
            const rows = await this.prismaService.metaVocabulary.findMany({
                where: { retired: false },
            });
            this.vocabulary = new Set(rows.map((row) => row.label));
            this.aliases = new Map();
            for (const row of rows) {
                for (const alias of row.aliases ?? []) this.aliases.set(alias, row.label);
            }
            this.vocabularyLoaded = true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            // An empty vocabulary is survivable: the model simply coins labels from scratch and
            // they are written back, so the list rebuilds itself over the following batches.
            this.logger.warn(`[Meta] Vocabulary load failed: ${msg}.`);
        }
    }

    private async growVocabulary(records: ReadonlyArray<MetaLabelRecord>): Promise<void> {
        const fresh = extractNewLabels(records, this.vocabulary, 1);
        const seen = new Set(records.map((r) => r.label).filter((l) => l !== UNLABELED));

        for (const label of fresh) {
            try {
                await this.prismaService.metaVocabulary.upsert({
                    where: { label },
                    update: { lastSeenAt: new Date() },
                    create: { label },
                });
                this.vocabulary.add(label);
                this.logger.log(`[Meta] New label entered the vocabulary: ${label}`);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.warn(`[Meta] Vocabulary upsert failed for ${label}: ${msg}.`);
            }
        }

        // Touch the labels that were reused, so a stale vocabulary entry can be told apart from one
        // the market is still producing tokens for.
        const reused = [...seen].filter((label) => !fresh.includes(label));
        if (reused.length === 0) return;
        try {
            await this.prismaService.metaVocabulary.updateMany({
                where: { label: { in: reused } },
                data: { lastSeenAt: new Date() },
            });
        } catch {
            // Freshness bookkeeping only; nothing downstream depends on it.
        }
    }
}
