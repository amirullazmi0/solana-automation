import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIService } from '../ai/ai.service';
import {
    DEFAULT_NARRATIVE_TTL_MS,
    NarrativeAdvice,
    NarrativeConfidence,
    NarrativeMetrics,
    NarrativeVerdict,
    shouldRefreshNarrative,
} from '../ai/narrative-advice';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Owns the narrative verdict for a mint: when to ask the model, where to keep the answer, and how
 * to hand it back without ever blocking a caller.
 *
 * Two properties drive the design:
 *
 *   - A verdict is static per token, so it is cached for a day and persisted, surviving restarts.
 *     An in-memory-only cache would re-pay the API cost for the same mints after every deploy.
 *   - `processNewToken` re-analyses one mint roughly once a second for up to twelve minutes. The
 *     in-flight guard is therefore mandatory, not defensive: without it a single token would fire
 *     dozens of identical requests before the first one returned.
 */
@Injectable()
export class NarrativeService {
    private readonly logger = new Logger(NarrativeService.name);
    private readonly cache = new Map<string, NarrativeAdvice>();
    private readonly inFlight = new Set<string>();

    constructor(
        private readonly configService: ConfigService,
        private readonly aiService: AIService,
        private readonly prismaService: PrismaService,
    ) {}

    private get enabled(): boolean {
        return (
            String(this.configService.get('ENABLE_AI_NARRATIVE_GATE', 'false')).toLowerCase() ===
            'true'
        );
    }

    private get ttlMs(): number {
        const raw = Number.parseInt(
            this.configService.get<string>('NARRATIVE_CACHE_TTL_MS', String(DEFAULT_NARRATIVE_TTL_MS)),
            10,
        );
        return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NARRATIVE_TTL_MS;
    }

    get minConfidence(): NarrativeConfidence {
        const raw = String(
            this.configService.get('NARRATIVE_MIN_CONFIDENCE', 'high'),
        ).toLowerCase();
        return raw === 'medium' || raw === 'low' ? raw : 'high';
    }

    get maxAgeMs(): number {
        return this.ttlMs;
    }

    get isEnabled(): boolean {
        return this.enabled;
    }

    /** Synchronous read. Returns undefined when nothing has been decided yet — never blocks. */
    getVerdict(tokenMint: string): NarrativeAdvice | undefined {
        if (!this.enabled) return undefined;
        return this.cache.get(tokenMint);
    }

    /**
     * Fire-and-forget. Warms the verdict for a mint while the caller goes on to do slower work
     * (RugCheck, creator profile, whale scoring), so the answer is usually waiting by the time the
     * buy decision is reached. Returns immediately in every case.
     */
    scheduleEvaluation(tokenMint: string, metrics: NarrativeMetrics, label?: string): void {
        if (!this.enabled) return;
        if (this.inFlight.has(tokenMint)) return;
        if (!shouldRefreshNarrative(this.cache.get(tokenMint), this.ttlMs)) return;

        this.inFlight.add(tokenMint);
        void this.loadOrEvaluate(tokenMint, metrics, label)
            .catch(() => undefined)
            .finally(() => {
                this.inFlight.delete(tokenMint);
            });
    }

    private async loadOrEvaluate(
        tokenMint: string,
        metrics: NarrativeMetrics,
        label?: string,
    ): Promise<void> {
        const persisted = await this.readPersisted(tokenMint);
        if (persisted && !shouldRefreshNarrative(persisted, this.ttlMs)) {
            this.cache.set(tokenMint, persisted);
            return;
        }

        const advice = await this.aiService.evaluateNarrative(tokenMint, metrics);
        // Never cache a failure: a transient API error must not lock in "no opinion" for a day.
        if (!advice) return;

        this.cache.set(tokenMint, advice);
        this.prune();
        await this.persist(tokenMint, advice, label);
    }

    private async readPersisted(tokenMint: string): Promise<NarrativeAdvice | undefined> {
        try {
            const row = await this.prismaService.tokenNarrative.findUnique({ where: { tokenMint } });
            if (!row) return undefined;
            return {
                verdict: row.verdict as NarrativeVerdict,
                confidenceLevel: row.confidence as NarrativeConfidence,
                reasoning: row.reasoning ?? '',
                evaluatedAt: row.evaluatedAt.getTime(),
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(`[Narrative] Read failed for ${tokenMint}: ${msg}.`);
            return undefined;
        }
    }

    private async persist(
        tokenMint: string,
        advice: NarrativeAdvice,
        label?: string,
    ): Promise<void> {
        try {
            const data = {
                verdict: advice.verdict,
                confidence: advice.confidenceLevel,
                reasoning: advice.reasoning.slice(0, 500),
                label: label ?? null,
                evaluatedAt: new Date(advice.evaluatedAt),
            };
            await this.prismaService.tokenNarrative.upsert({
                where: { tokenMint },
                update: data,
                create: { tokenMint, ...data },
            });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            // The in-memory copy is already set, so a DB failure only costs persistence.
            this.logger.warn(`[Narrative] Persist failed for ${tokenMint}: ${msg}.`);
        }
    }

    private prune(): void {
        const ttl = this.ttlMs;
        const now = Date.now();
        for (const [mint, advice] of this.cache.entries()) {
            if (now - advice.evaluatedAt > ttl) this.cache.delete(mint);
        }
    }
}
