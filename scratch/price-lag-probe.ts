/**
 * How stale is the price the stop loss is measured against?
 *
 * PriceMonitorService polls every second (`@Interval(1000)`) but reads
 * `api.dexscreener.com/latest/dex/tokens/...`, an aggregator whose pair data refreshes on its own
 * cadence. If that cadence is tens of seconds, the monitor can only notice an -8% stop once the
 * feed catches up -- by which time the real price has moved much further. Production shows stops
 * configured at -8% triggering at -17% on average, flat across every liquidity bucket, which is the
 * signature of late detection rather than slippage.
 *
 * This measures it directly: poll both DexScreener and Jupiter for the same mints once a second and
 * report how often each source actually changes its number, plus how far apart they drift.
 *
 *   npx ts-node --transpile-only scratch/price-lag-probe.ts [seconds] [mint ...]
 */
import * as https from 'https';

const DURATION_S = Number.parseInt(process.argv[2] || '', 10) || 90;

function get<T>(host: string, path: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = https.get(
            { host, path, family: 4, timeout: 10000, headers: { accept: 'application/json' } },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data || 'null') as T);
                    } catch (e) {
                        reject(e as Error);
                    }
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
        });
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DexPair {
    chainId: string;
    baseToken?: { address?: string; symbol?: string };
    priceUsd?: string;
    liquidity?: { usd?: number };
    volume?: { m5?: number };
}

async function pickMints(): Promise<Array<{ mint: string; symbol: string }>> {
    const seen = new Set<string>();
    for (const path of ['/token-boosts/latest/v1', '/token-profiles/latest/v1']) {
        const feed = await get<Array<{ chainId: string; tokenAddress: string }>>(
            'api.dexscreener.com',
            path,
        );
        for (const i of feed || []) {
            if (i.chainId === 'solana' && i.tokenAddress) seen.add(i.tokenAddress);
        }
        await sleep(250);
    }
    const all = [...seen].slice(0, 30);
    const res = await get<{ pairs: DexPair[] }>(
        'api.dexscreener.com',
        `/latest/dex/tokens/${all.join(',')}`,
    );
    const best = new Map<string, DexPair>();
    for (const p of res?.pairs || []) {
        const a = p.baseToken?.address;
        if (!a || p.chainId !== 'solana') continue;
        const prev = best.get(a);
        if (prev && (prev.volume?.m5 || 0) >= (p.volume?.m5 || 0)) continue;
        best.set(a, p);
    }
    // The busiest tokens: the ones where a stale price costs the most.
    return [...best.entries()]
        .sort((a, b) => (b[1].volume?.m5 || 0) - (a[1].volume?.m5 || 0))
        .slice(0, 3)
        .map(([mint, p]) => ({ mint, symbol: p.baseToken?.symbol || mint.slice(0, 6) }));
}

async function dexPrice(mint: string): Promise<number | undefined> {
    const res = await get<{ pairs: DexPair[] }>(
        'api.dexscreener.com',
        `/latest/dex/tokens/${mint}`,
    );
    const pairs = (res?.pairs || []).filter((p) => p.chainId === 'solana');
    const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const n = Number.parseFloat(best?.priceUsd || '');
    return Number.isFinite(n) ? n : undefined;
}

async function jupPrice(mint: string): Promise<number | undefined> {
    const res = await get<{ [k: string]: { usdPrice?: number } }>(
        'lite-api.jup.ag',
        `/price/v3?ids=${mint}`,
    );
    const n = res?.[mint]?.usdPrice;
    return Number.isFinite(n) ? Number(n) : undefined;
}

async function main() {
    const explicit = process.argv.slice(3);
    const targets = explicit.length
        ? explicit.map((m) => ({ mint: m, symbol: m.slice(0, 6) }))
        : await pickMints();

    console.log(`Mengukur ${targets.length} token selama ${DURATION_S} detik, sampel tiap 1 detik\n`);
    for (const t of targets) console.log(`  ${t.symbol.padEnd(14)} ${t.mint}`);
    console.log();

    const stats = targets.map((t) => ({
        ...t,
        dexSamples: 0,
        dexChanges: 0,
        dexLast: undefined as number | undefined,
        dexLastChangeAt: 0,
        dexGaps: [] as number[],
        jupSamples: 0,
        jupChanges: 0,
        jupLast: undefined as number | undefined,
        jupLastChangeAt: 0,
        jupGaps: [] as number[],
        drifts: [] as number[],
    }));

    const started = Date.now();
    while ((Date.now() - started) / 1000 < DURATION_S) {
        const now = Date.now();
        await Promise.all(
            stats.map(async (s) => {
                const [d, j] = await Promise.all([
                    dexPrice(s.mint).catch(() => undefined),
                    jupPrice(s.mint).catch(() => undefined),
                ]);

                if (d !== undefined) {
                    s.dexSamples += 1;
                    if (s.dexLast !== undefined && d !== s.dexLast) {
                        s.dexChanges += 1;
                        if (s.dexLastChangeAt) s.dexGaps.push((now - s.dexLastChangeAt) / 1000);
                        s.dexLastChangeAt = now;
                    } else if (s.dexLast === undefined) {
                        s.dexLastChangeAt = now;
                    }
                    s.dexLast = d;
                }

                if (j !== undefined) {
                    s.jupSamples += 1;
                    if (s.jupLast !== undefined && j !== s.jupLast) {
                        s.jupChanges += 1;
                        if (s.jupLastChangeAt) s.jupGaps.push((now - s.jupLastChangeAt) / 1000);
                        s.jupLastChangeAt = now;
                    } else if (s.jupLast === undefined) {
                        s.jupLastChangeAt = now;
                    }
                    s.jupLast = j;
                }

                if (d !== undefined && j !== undefined && j > 0) {
                    s.drifts.push(((d - j) / j) * 100);
                }
            }),
        );
        await sleep(1000);
    }

    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const maxAbs = (a: number[]) => (a.length ? Math.max(...a.map(Math.abs)) : 0);

    console.log('=== SEBERAPA SERING TIAP SUMBER BERUBAH ANGKANYA ===\n');
    for (const s of stats) {
        console.log(`${s.symbol}`);
        console.log(
            `  DexScreener : ${s.dexChanges} perubahan / ${s.dexSamples} sampel` +
                `   jeda rata-rata ${avg(s.dexGaps).toFixed(1)}s   terlama ${Math.max(0, ...s.dexGaps).toFixed(1)}s`,
        );
        console.log(
            `  Jupiter     : ${s.jupChanges} perubahan / ${s.jupSamples} sampel` +
                `   jeda rata-rata ${avg(s.jupGaps).toFixed(1)}s   terlama ${Math.max(0, ...s.jupGaps).toFixed(1)}s`,
        );
        console.log(
            `  Selisih harga: rata-rata ${avg(s.drifts).toFixed(2)}%   terbesar ${maxAbs(s.drifts).toFixed(2)}%`,
        );
        console.log();
    }

    const allDexGaps = stats.flatMap((s) => s.dexGaps);
    const allJupGaps = stats.flatMap((s) => s.jupGaps);
    const allDrift = stats.flatMap((s) => s.drifts);
    console.log('=== RINGKASAN ===');
    console.log(`  DexScreener jeda rata-rata : ${avg(allDexGaps).toFixed(1)}s`);
    console.log(`  Jupiter jeda rata-rata     : ${avg(allJupGaps).toFixed(1)}s`);
    console.log(`  Selisih terbesar           : ${maxAbs(allDrift).toFixed(2)}%`);
    process.exit(0);
}

void main();
