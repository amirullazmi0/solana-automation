import { PendingSellStore, PendingSellStoreIo, PendingSellRecord } from './pending-sell-store';

/**
 * In-memory fake filesystem implementing the injectable IO surface. Backs a
 * single logical "disk" shared across store instances so we can prove that
 * state written by one store is reloaded by a fresh store (the restart case).
 */
class FakeFs implements PendingSellStoreIo {
    files = new Map<string, string>();
    dirs = new Set<string>();
    failWrites = false;
    failReads = false;

    existsSync(p: string): boolean {
        return this.files.has(p) || this.dirs.has(p);
    }
    readFileSync(p: string): string {
        if (this.failReads) throw new Error('EIO read');
        const v = this.files.get(p);
        if (v === undefined) throw new Error('ENOENT ' + p);
        return v;
    }
    writeFileSync(p: string, data: string): void {
        if (this.failWrites) throw new Error('EIO write');
        this.files.set(p, data);
    }
    renameSync(from: string, to: string): void {
        const v = this.files.get(from);
        if (v === undefined) throw new Error('ENOENT rename ' + from);
        this.files.set(to, v);
        this.files.delete(from);
    }
    mkdirSync(p: string): void {
        this.dirs.add(p);
    }
}

const FILE = '/data/pending-sell-signatures.json';
const TTL = 90_000;
const rec = (signature: string, recordedAt: number): PendingSellRecord => ({ signature, recordedAt });

describe('PendingSellStore', () => {
    it('behaves like the Map it replaces: get/set/delete', () => {
        const fs = new FakeFs();
        const store = new PendingSellStore(FILE, TTL, fs);
        expect(store.get(1)).toBeUndefined();
        store.set(1, rec('sigA', 1000));
        expect(store.get(1)).toEqual(rec('sigA', 1000));
        store.delete(1);
        expect(store.get(1)).toBeUndefined();
    });

    it('persists a set() to disk atomically (temp write then rename, no leftover temp)', () => {
        const fs = new FakeFs();
        const store = new PendingSellStore(FILE, TTL, fs);
        store.set(7, rec('sig7', 5000));
        // Final file exists, temp does not.
        expect(fs.files.has(FILE)).toBe(true);
        expect(fs.files.has(FILE + '.tmp')).toBe(false);
        expect(JSON.parse(fs.files.get(FILE) as string)).toEqual({ '7': rec('sig7', 5000) });
    });

    it('survives a restart: a fresh store reloads signatures written by a prior instance', () => {
        const fs = new FakeFs();
        const now = 1_000_000;
        const first = new PendingSellStore(FILE, TTL, fs);
        first.set(42, rec('sig42', now));
        // Simulate process death + restart: brand-new store over the same disk.
        const second = new PendingSellStore(FILE, TTL, fs);
        expect(second.get(42)).toBeUndefined(); // not loaded yet
        second.load(now + 1000); // within the validity window
        expect(second.get(42)).toEqual(rec('sig42', now));
    });

    it('prunes entries already past the validity window on load (a stale re-sell is safe)', () => {
        const fs = new FakeFs();
        const now = 1_000_000;
        const first = new PendingSellStore(FILE, TTL, fs);
        first.set(1, rec('fresh', now)); // within window
        first.set(2, rec('stale', now - TTL - 1)); // past window
        const second = new PendingSellStore(FILE, TTL, fs);
        second.load(now);
        expect(second.get(1)).toEqual(rec('fresh', now));
        expect(second.get(2)).toBeUndefined();
        expect(second.size()).toBe(1);
        // Pruned entry is compacted out of the file too.
        expect(JSON.parse(fs.files.get(FILE) as string)).toEqual({ '1': rec('fresh', now) });
    });

    it('load on a missing file starts empty and does not throw', () => {
        const fs = new FakeFs();
        const store = new PendingSellStore(FILE, TTL, fs);
        expect(() => store.load()).not.toThrow();
        expect(store.size()).toBe(0);
    });

    it('load on corrupt JSON starts empty and does not throw', () => {
        const fs = new FakeFs();
        fs.files.set(FILE, '{ this is not valid json ');
        const store = new PendingSellStore(FILE, TTL, fs);
        expect(() => store.load()).not.toThrow();
        expect(store.size()).toBe(0);
    });

    it('load skips malformed entries but keeps well-formed ones', () => {
        const fs = new FakeFs();
        const now = 2_000_000;
        fs.files.set(
            FILE,
            JSON.stringify({
                '1': { signature: 'ok', recordedAt: now },
                '2': { signature: '', recordedAt: now }, // empty sig -> skip
                '3': { recordedAt: now }, // missing sig -> skip
                '4': { signature: 'x', recordedAt: 'nope' }, // bad ts -> skip
                bad: { signature: 'y', recordedAt: now }, // non-numeric key -> skip
            }),
        );
        const store = new PendingSellStore(FILE, TTL, fs);
        store.load(now);
        expect(store.size()).toBe(1);
        expect(store.get(1)).toEqual(rec('ok', now));
    });

    it('FAIL-SOFT: a write error never throws; in-memory state is still updated', () => {
        const fs = new FakeFs();
        fs.failWrites = true;
        const store = new PendingSellStore(FILE, TTL, fs);
        expect(() => store.set(1, rec('sig', 1000))).not.toThrow();
        // In-memory value is authoritative even though the disk write failed.
        expect(store.get(1)).toEqual(rec('sig', 1000));
        expect(fs.files.has(FILE)).toBe(false);
    });

    it('FAIL-SOFT: a read error during load never throws and starts empty', () => {
        const fs = new FakeFs();
        fs.files.set(FILE, '{}');
        fs.failReads = true;
        const store = new PendingSellStore(FILE, TTL, fs);
        expect(() => store.load()).not.toThrow();
        expect(store.size()).toBe(0);
    });

    it('delete of an absent key does not write (no needless persist)', () => {
        const fs = new FakeFs();
        const store = new PendingSellStore(FILE, TTL, fs);
        store.delete(999);
        expect(fs.files.has(FILE)).toBe(false);
    });

    it('a later set() overwrites the prior signature for the same trade', () => {
        const fs = new FakeFs();
        const store = new PendingSellStore(FILE, TTL, fs);
        store.set(5, rec('old', 1000));
        store.set(5, rec('new', 2000));
        expect(store.get(5)).toEqual(rec('new', 2000));
        const reloaded = new PendingSellStore(FILE, TTL, fs);
        reloaded.load(2000);
        expect(reloaded.get(5)).toEqual(rec('new', 2000));
    });

    // Regression (finding: recovery path zeroed the tip). jitoTipLamports must
    // survive a persist -> restart -> load round trip, exactly like
    // percentage/exitReason above, so a LANDED_OK reconciliation after a crash
    // still reports the real tip paid instead of undercounting totalFeesSol.
    describe('jitoTipLamports', () => {
        it('round-trips through persist and a fresh-store load', () => {
            const fs = new FakeFs();
            const now = 3_000_000;
            const first = new PendingSellStore(FILE, TTL, fs);
            first.set(9, { signature: 'sig9', recordedAt: now, jitoTipLamports: 12345 });
            expect(JSON.parse(fs.files.get(FILE) as string)['9'].jitoTipLamports).toBe(12345);

            const second = new PendingSellStore(FILE, TTL, fs);
            second.load(now);
            expect(second.get(9)).toEqual({
                signature: 'sig9',
                recordedAt: now,
                jitoTipLamports: 12345,
            });
        });

        it('is optional: a record written before the field existed loads without it', () => {
            const fs = new FakeFs();
            const now = 3_000_000;
            fs.files.set(FILE, JSON.stringify({ '1': { signature: 'old-sig', recordedAt: now } }));
            const store = new PendingSellStore(FILE, TTL, fs);
            store.load(now);
            expect(store.get(1)).toEqual({ signature: 'old-sig', recordedAt: now });
            expect(store.get(1)?.jitoTipLamports).toBeUndefined();
        });

        it('a non-finite jitoTipLamports on disk is dropped, not propagated', () => {
            const fs = new FakeFs();
            const now = 3_000_000;
            fs.files.set(
                FILE,
                JSON.stringify({ '2': { signature: 'sig2', recordedAt: now, jitoTipLamports: 'NaN' } }),
            );
            const store = new PendingSellStore(FILE, TTL, fs);
            store.load(now);
            expect(store.get(2)).toEqual({ signature: 'sig2', recordedAt: now });
            expect(store.get(2)?.jitoTipLamports).toBeUndefined();
        });

        it('0 (Jito not used) is a valid tip and is preserved, not treated as missing', () => {
            const fs = new FakeFs();
            const store = new PendingSellStore(FILE, TTL, fs);
            store.set(3, rec('sig3', 1000));
            store.set(3, { signature: 'sig3', recordedAt: 1000, jitoTipLamports: 0 });
            expect(store.get(3)?.jitoTipLamports).toBe(0);
        });
    });
});
