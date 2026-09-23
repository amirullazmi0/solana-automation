/**
 * What the discovery feeds actually contain.
 *
 * Thresholds should be set against the population they will filter, not guessed. This samples the
 * same two DexScreener feeds the scanner polls, resolves each mint, and prints the distribution of
 * every quantity the traction gate checks -- so a proposed floor can be read off real percentiles
 * instead of invented.
 *
 *   npx ts-node --transpile-only scratch/feed-distribution.ts
 */
import * as https from 'https';

interface DexPair {
    chainId: string;
    baseToken?: { address?: string; name?: string; symbol?: string };
    volume?: { m5?: number; h1?: number; h24?: number };
    txns?: { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
    liquidity?: { usd?: number };
    fdv?: number;
    pairCreatedAt?: number;
}

function get<T>(host: string, path: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = https.get(
            { host, path, family: 4, timeout: 20000, headers: { accept: 'application/json' } },
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

function pct(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[i];
}

function describe(name: string, values: number[], fmt: (n: number) => string): void {
    const s = [...values].sort((a, b) => a - b);
    console.log(
        `${name.padEnd(16)} n=${String(s.length).padStart(3)}  ` +
            `p10=${fmt(pct(s, 10)).padStart(12)}  p50=${fmt(pct(s, 50)).padStart(12)}  ` +
            `p75=${fmt(pct(s, 75)).padStart(12)}  p90=${fmt(pct(s, 90)).padStart(12)}  ` +
            `max=${fmt(s[s.length - 1] ?? 0).padStart(12)}`,
    );
}

const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const num = (n: number) => String(Math.round(n * 100) / 100);

async function main() {
    const mints = new Set<string>();
    for (const path of ['/token-boosts/latest/v1', '/token-profiles/latest/v1']) {
        const feed = await get<Array<{ chainId: string; tokenAddress: string }>>(
            'api.dexscreener.com',
            path,
        );
        for (const item of feed || []) {
            if (item.chainId === 'solana' && item.tokenAddress) mints.add(item.tokenAddress);
        }
        await sleep(300);
    }

    const all = [...mints];
    const best = new Map<string, DexPair>();
    for (let i = 0; i < all.length; i += 30) {
        const res = await get<{ pairs: DexPair[] }>(
            'api.dexscreener.com',
            `/latest/dex/tokens/${all.slice(i, i + 30).join(',')}`,
        );
        for (const pair of res?.pairs || []) {
            const addr = pair.baseToken?.address;
            if (!addr || pair.chainId !== 'solana') continue;
            const prev = best.get(addr);
            if (prev && (prev.liquidity?.usd || 0) >= (pair.liquidity?.usd || 0)) continue;
            best.set(addr, pair);
        }
        await sleep(400);
    }

    const rows = [...best.values()];
    const liq = rows.map((p) => p.liquidity?.usd || 0);
    const mcap = rows.map((p) => p.fdv || 0);
    const vol5 = rows.map((p) => p.volume?.m5 || 0);
    const volH1 = rows.map((p) => p.volume?.h1 || 0);
    const buys5 = rows.map((p) => p.txns?.m5?.buys || 0);
    const ageH = rows.map((p) =>
        p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3_600_000 : 0,
    );

    console.log(`\nSampel feed discovery: ${rows.length} token dengan pair\n`);
    describe('likuiditas', liq, usd);
    describe('market cap', mcap, usd);
    describe('volume 5m', vol5, usd);
    describe('volume 1h', volH1, usd);
    describe('buys 5m', buys5, num);
    describe('umur (jam)', ageH, num);

    // How many survive each candidate floor, one gate at a time and then combined.
    console.log('\n=== Berapa token yang lolos tiap ambang (satu per satu) ===');
    const checks: Array<[string, (p: DexPair) => boolean]> = [
        ['umur >= 6 jam', (p) => (p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : 0) >= 6],
        ['likuiditas >= $50k', (p) => (p.liquidity?.usd || 0) >= 50_000],
        ['likuiditas >= $25k', (p) => (p.liquidity?.usd || 0) >= 25_000],
        ['likuiditas >= $15k', (p) => (p.liquidity?.usd || 0) >= 15_000],
        ['mcap >= $200k', (p) => (p.fdv || 0) >= 200_000],
        ['vol5m >= $5k', (p) => (p.volume?.m5 || 0) >= 5_000],
        ['vol5m >= $1k', (p) => (p.volume?.m5 || 0) >= 1_000],
        ['buys5m >= 25', (p) => (p.txns?.m5?.buys || 0) >= 25],
    ];
    for (const [label, fn] of checks) {
        const n = rows.filter(fn).length;
        console.log(`  ${label.padEnd(22)} ${String(n).padStart(3)}/${rows.length}`);
    }

    const strict = rows.filter(
        (p) =>
            (p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : 0) >= 6 &&
            (p.liquidity?.usd || 0) >= 50_000 &&
            (p.fdv || 0) >= 200_000 &&
            (p.volume?.m5 || 0) >= 5_000,
    );
    const moderate = rows.filter(
        (p) =>
            (p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : 0) >= 6 &&
            (p.liquidity?.usd || 0) >= 25_000 &&
            (p.fdv || 0) >= 200_000 &&
            (p.volume?.m5 || 0) >= 1_000,
    );
    console.log(`\n=== Gabungan ===`);
    console.log(`  Ketat   (6j, $50k, $200k, vol5m $5k): ${strict.length}/${rows.length}`);
    console.log(`  Sedang  (6j, $25k, $200k, vol5m $1k): ${moderate.length}/${rows.length}`);
    for (const p of moderate.slice(0, 8)) {
        console.log(
            `    ${(p.baseToken?.symbol || '?').padEnd(12)} liq=${usd(p.liquidity?.usd || 0).padStart(10)}` +
                ` mcap=${usd(p.fdv || 0).padStart(12)} vol5m=${usd(p.volume?.m5 || 0).padStart(9)}` +
                ` umur=${num(p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : 0)}j`,
        );
    }
    process.exit(0);
}

void main();
