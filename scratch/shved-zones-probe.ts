/**
 * Runs the ported Shved zone algorithm against real candles and prints the bands next to the live
 * price.
 *
 * This is the only way to verify a port. Unit tests prove the code does what I wrote; they cannot
 * prove I transcribed the indicator correctly. The tell is simple and visual: real zones bracket
 * the price. If every band lands on one side, the port is wrong.
 *
 *   npx ts-node --transpile-only scratch/shved-zones-probe.ts [mint ...]
 *
 * GeckoTerminal's free tier allows roughly 30 requests per minute and I hit a 429 with six calls in
 * a row, so this deliberately crawls.
 */
import * as https from 'https';
import {
    Candle,
    computeShvedZones,
    distancePct,
    minimumCandles,
    resolveNearestZones,
} from '../src/dashboard/shved-zones';

const AGGREGATE_MIN = 5;
const CANDLE_LIMIT = 300;
const GECKO_DELAY_MS = 2500;

function get<T>(host: string, path: string): Promise<{ status?: number; data?: T; err?: string }> {
    return new Promise((resolve) => {
        const req = https.get(
            {
                host,
                path,
                family: 4,
                timeout: 25000,
                headers: { accept: 'application/json', 'user-agent': 'curl/8' },
            },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, data: JSON.parse(body || 'null') as T });
                    } catch {
                        resolve({ status: res.statusCode, err: 'parse' });
                    }
                });
            },
        );
        req.on('error', (e) => resolve({ err: e.message }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ err: 'timeout' });
        });
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pair {
    chainId?: string;
    pairAddress?: string;
    dexId?: string;
    priceUsd?: string;
    liquidity?: { usd?: number };
    volume?: { h24?: number };
    pairCreatedAt?: number;
    baseToken?: { address?: string; symbol?: string };
}

/** The deepest Solana pair for a mint — the same choice the bot's analyzer makes. */
async function deepestPair(mints: string[]): Promise<Pair[]> {
    const res = await get<{ pairs?: Pair[] }>(
        'api.dexscreener.com',
        `/latest/dex/tokens/${mints.join(',')}`,
    );
    const best = new Map<string, Pair>();
    for (const p of res.data?.pairs ?? []) {
        const addr = p.baseToken?.address;
        if (!addr || p.chainId !== 'solana') continue;
        const prev = best.get(addr);
        if (prev && (prev.liquidity?.usd || 0) >= (p.liquidity?.usd || 0)) continue;
        best.set(addr, p);
    }
    return [...best.values()];
}

async function discoverBusiest(): Promise<Pair[]> {
    const feed = await get<Array<{ chainId: string; tokenAddress: string }>>(
        'api.dexscreener.com',
        '/token-boosts/latest/v1',
    );
    const mints = [
        ...new Set((feed.data ?? []).filter((t) => t.chainId === 'solana').map((t) => t.tokenAddress)),
    ].slice(0, 30);
    const pairs = await deepestPair(mints);
    return pairs
        .filter((p) => (p.liquidity?.usd || 0) >= 25_000)
        .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
        .slice(0, 3);
}

async function fetchCandles(pool: string, mint: string): Promise<Candle[]> {
    // `token=<mint>` is mandatory, not optional. Without it GeckoTerminal prices whichever side it
    // considers the pool's base, and for a TOKEN/TOKEN pool that is the wrong one: a USEFUL/USELESS
    // pool returned USELESS at $0.23 while USEFUL actually traded at $0.000126, a 1,800x error that
    // still produced perfectly plausible-looking zones.
    const res = await get<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
        'api.geckoterminal.com',
        `/api/v2/networks/solana/pools/${pool}/ohlcv/minute` +
            `?aggregate=${AGGREGATE_MIN}&limit=${CANDLE_LIMIT}&currency=usd&token=${mint}`,
    );
    if (res.status === 429) {
        console.log('   (429 rate limited)');
        return [];
    }
    const list = res.data?.data?.attributes?.ohlcv_list ?? [];
    // GeckoTerminal returns newest-first; the algorithm takes chronological order.
    return list
        .map(([at, open, high, low, close, volume]) => ({ at, open, high, low, close, volume }))
        .filter((c) => Number.isFinite(c.close) && c.close > 0)
        .sort((a, b) => a.at - b.at);
}

const fmt = (n: number) => (n >= 1 ? n.toFixed(4) : n.toPrecision(4));

async function main() {
    const explicit = process.argv.slice(2);
    const pairs = explicit.length ? await deepestPair(explicit) : await discoverBusiest();

    if (pairs.length === 0) {
        console.log('Tidak ada pair yang bisa diuji.');
        process.exit(1);
    }

    console.log(`Minimum candle yang dibutuhkan: ${minimumCandles()}\n`);
    let bracketed = 0;
    let evaluated = 0;

    for (const p of pairs) {
        await sleep(GECKO_DELAY_MS);

        const symbol = p.baseToken?.symbol ?? '?';
        const ageH = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : Number.NaN;
        const price = Number.parseFloat(p.priceUsd || '0');
        const candles = await fetchCandles(p.pairAddress || '', p.baseToken?.address || '');

        console.log(
            `${symbol}  umur=${Number.isFinite(ageH) ? ageH.toFixed(1) + 'j' : '?'}  ` +
                `liq=$${Math.round(p.liquidity?.usd || 0).toLocaleString('en-US')}  ` +
                `candle=${candles.length}  harga=$${fmt(price)}`,
        );

        // Cross-check the two sources before trusting either. A wide divergence means the candle
        // series is describing a different asset than the price, and zones from it are fiction.
        const lastClose = candles.length > 0 ? candles[candles.length - 1].close : Number.NaN;
        if (Number.isFinite(lastClose) && price > 0) {
            const ratio = lastClose / price;
            if (ratio > 5 || ratio < 0.2) {
                console.log(
                    `   SKALA TIDAK COCOK: candle=$${fmt(lastClose)} vs dexscreener=$${fmt(price)} ` +
                        `(${ratio.toFixed(1)}x) -> data dibuang
`,
                );
                continue;
            }
        }

        if (candles.length < minimumCandles()) {
            console.log('   candle belum cukup -> tidak menghitung zona (ini perilaku yang benar)\n');
            continue;
        }

        const zones = computeShvedZones(candles);
        const { support, resistance } = resolveNearestZones(zones, price);
        evaluated += 1;

        console.log(`   zona ditemukan: ${zones.length}`);
        for (const z of zones.slice(0, 6)) {
            const tag = z.type === 'SUPPORT' ? 'BELI ' : 'JUAL ';
            console.log(
                `     ${tag} ${z.strength.padEnd(8)} $${fmt(z.low)} .. $${fmt(z.high)}  hits=${z.hits}${z.turned ? ' (turncoat)' : ''}`,
            );
        }

        const sPct = support ? distancePct(price, support.high) : undefined;
        const rPct = resistance ? distancePct(price, resistance.low) : undefined;
        console.log(
            `   terdekat -> beli ${support ? `$${fmt(support.low)}..$${fmt(support.high)} (${sPct?.toFixed(1)}%)` : 'tidak ada'}` +
                ` | jual ${resistance ? `$${fmt(resistance.low)}..$${fmt(resistance.high)} (${rPct?.toFixed(1)}%)` : 'tidak ada'}`,
        );

        if (support && resistance) {
            bracketed += 1;
            console.log('   OK: harga terapit zona beli dan jual');
        } else {
            console.log('   catatan: hanya satu sisi yang punya zona');
        }
        console.log();
    }

    console.log('=== VONIS PORT ===');
    console.log(`Token dievaluasi : ${evaluated}`);
    console.log(`Harga terapit    : ${bracketed}`);
    if (evaluated === 0) {
        console.log('Tidak ada yang punya candle cukup. Jalankan lagi, atau coba mint yang lebih tua.');
    } else if (bracketed === 0) {
        console.log('Tidak ada satu pun harga yang terapit. Portingnya kemungkinan besar salah.');
    } else {
        console.log('Zona mengapit harga seperti yang diharapkan dari indikator ini.');
    }
    console.log(
        '\nCatatan: ini memeriksa BENTUK, bukan kegunaan. Apakah zonanya berarti sesuatu pada\n' +
            'memecoin adalah pertanyaan terpisah yang hanya bisa dijawab dengan hasil trade.',
    );
    process.exit(0);
}

void main();
