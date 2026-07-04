/**
 * pending-sell-store.ts
 *
 * Disk-backed persistence for post-broadcast UNCONFIRMED sell signatures,
 * keyed by tradeId. Closes the restart hole in the double-sell reconciliation
 * gate: the in-memory Map alone was process-local, so a crash/restart WITHIN a
 * sell tx's validity window (SELL_UNCONFIRMED_TTL_MS, default ~90s) lost the
 * pending signature. On restart `startMonitoringAllTrades` resumes OPEN trades,
 * and without the pending record the reconciliation gate in TradeService could
 * not fire — a still-in-flight partial sell could be re-executed (oversell).
 * (finding: idempotency state is process-local with no persistence.)
 *
 * Design rules:
 *   - FAIL-SOFT: an I/O error NEVER throws into the trading path. A persistence
 *     miss degrades to the old in-memory-only behavior; it must never block or
 *     crash a sell.
 *   - ATOMIC WRITES: write a temp sibling then rename, so a crash mid-write can
 *     never leave a half-written (corrupt) file that would wipe good state.
 *   - PRUNE-ON-LOAD: entries already past the validity window are dropped on
 *     load. Past the window a re-sell is safe regardless (a landed tx already
 *     reduced the balance; an un-landed tx can never land) — exactly the
 *     semantics resolveSignatureFate() relies on — so keeping them would only
 *     pin dead entries forever and grow the file unbounded.
 *   - API-COMPATIBLE with the Map<number,{signature,recordedAt}> it replaces
 *     (get/set/delete) so the TradeService call sites are unchanged.
 *
 * Pure and dependency-free (fs + optional injected IO for unit tests).
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PendingSellRecord {
    signature: string;
    recordedAt: number;
    /**
     * Fraction of the position the broadcast sell was exiting (1.0 = full exit,
     * <1 = partial take-profit). Optional for backward compatibility with files
     * written before this field existed. When a LANDED_OK reconciliation recovers
     * the fill, this decides whether the trade is CLOSED (full) or reduced (partial)
     * — without it a partial exit would be mis-finalized as a full close.
     */
    percentage?: number;
    /** Exit reason of the broadcast sell, preserved so the reconciled finalize
     *  reports/closes with the original reason (STOP_LOSS, PARTIAL_TAKE_PROFIT, …). */
    exitReason?: string;
}

/** Minimal filesystem surface, injectable so unit tests can use an in-memory
 *  fake and simulate I/O failures deterministically. */
export interface PendingSellStoreIo {
    existsSync: (p: string) => boolean;
    readFileSync: (p: string) => string;
    writeFileSync: (p: string, data: string) => void;
    renameSync: (from: string, to: string) => void;
    mkdirSync: (p: string) => void;
}

const nodeIo: PendingSellStoreIo = {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p) => fs.readFileSync(p, 'utf8'),
    writeFileSync: (p, data) => fs.writeFileSync(p, data, 'utf8'),
    renameSync: (from, to) => fs.renameSync(from, to),
    mkdirSync: (p) => {
        fs.mkdirSync(p, { recursive: true });
    },
};

export class PendingSellStore {
    private readonly map = new Map<number, PendingSellRecord>();

    /**
     * @param filePath absolute path to the JSON backing file.
     * @param ttlMs    validity window; entries older than this are pruned on load.
     * @param io       filesystem surface (default: real fs). Injected in tests.
     * @param log      optional logger sink (default: no-op) for load/persist notes.
     */
    constructor(
        private readonly filePath: string,
        private readonly ttlMs: number,
        private readonly io: PendingSellStoreIo = nodeIo,
        private readonly log: (msg: string) => void = () => {
            /* no-op */
        },
    ) {}

    /**
     * Rehydrate from disk. Idempotent; call once at module init BEFORE any
     * trade tick can run. Corrupt/unreadable/missing file -> start empty (never
     * throws). Entries past the validity window are dropped.
     */
    load(now: number = Date.now()): void {
        try {
            if (!this.io.existsSync(this.filePath)) return;
            const raw = this.io.readFileSync(this.filePath);
            if (!raw || !raw.trim()) return;
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (!parsed || typeof parsed !== 'object') return;
            let loaded = 0;
            let pruned = 0;
            for (const [key, value] of Object.entries(parsed)) {
                const id = Number(key);
                const rec = value as Partial<PendingSellRecord> | null;
                if (
                    !Number.isFinite(id) ||
                    !rec ||
                    typeof rec.signature !== 'string' ||
                    !rec.signature ||
                    typeof rec.recordedAt !== 'number' ||
                    !Number.isFinite(rec.recordedAt)
                ) {
                    continue; // skip malformed entry, keep the rest
                }
                if (now - rec.recordedAt > this.ttlMs) {
                    pruned++;
                    continue; // stale beyond the window -> safe to drop
                }
                const restored: PendingSellRecord = {
                    signature: rec.signature,
                    recordedAt: rec.recordedAt,
                };
                if (typeof rec.percentage === 'number' && Number.isFinite(rec.percentage)) {
                    restored.percentage = rec.percentage;
                }
                if (typeof rec.exitReason === 'string' && rec.exitReason) {
                    restored.exitReason = rec.exitReason;
                }
                this.map.set(id, restored);
                loaded++;
            }
            this.log(
                `[PendingSellStore] Loaded ${loaded} pending sell signature(s) from ${this.filePath}` +
                    (pruned ? ` (pruned ${pruned} stale)` : '') +
                    '.',
            );
            // If we pruned anything, compact the file so dead entries don't linger.
            if (pruned > 0) this.persist();
        } catch (e) {
            this.log(
                `[PendingSellStore] Could not load ${this.filePath}: ` +
                    `${e instanceof Error ? e.message : String(e)}. Starting with empty in-memory state.`,
            );
        }
    }

    get(tradeId: number): PendingSellRecord | undefined {
        return this.map.get(tradeId);
    }

    set(tradeId: number, record: PendingSellRecord): void {
        this.map.set(tradeId, record);
        this.persist();
    }

    delete(tradeId: number): void {
        const had = this.map.delete(tradeId);
        if (had) this.persist();
    }

    /** Number of pending entries currently held (test/inspection helper). */
    size(): number {
        return this.map.size;
    }

    /** Serialize the current map to disk atomically. Fail-soft: never throws;
     *  on failure the in-memory state is authoritative until the next write. */
    private persist(): void {
        try {
            const dir = path.dirname(this.filePath);
            if (!this.io.existsSync(dir)) {
                this.io.mkdirSync(dir);
            }
            const obj: Record<string, PendingSellRecord> = {};
            for (const [id, rec] of this.map.entries()) {
                obj[String(id)] = rec;
            }
            const tmp = `${this.filePath}.tmp`;
            this.io.writeFileSync(tmp, JSON.stringify(obj));
            this.io.renameSync(tmp, this.filePath);
        } catch (e) {
            this.log(
                `[PendingSellStore] Persist failed for ${this.filePath}: ` +
                    `${e instanceof Error ? e.message : String(e)}. In-memory state retained.`,
            );
        }
    }
}
