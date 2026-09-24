/**
 * Walks the real SOL price series through the predictor and grades every call.
 *
 * This runs BEFORE the feature ships, because it is the only thing that can answer whether the
 * signal is worth sending at all. A predictor that cannot beat "always answer FLAT" or "assume the
 * last move continues" is not a predictor, and shipping it would mean sending authoritative-looking
 * messages built on nothing.
 *
 *   npx ts-node --transpile-only scratch/sol-prediction-backtest.ts [hours]
 *
 * Works on timestamps rather than array positions, so the price source can be swapped without
 * touching the logic -- the two available sources disagree on sampling interval.
 *
 * Scope limit, stated plainly: only the SOL-momentum half of the model is exercised here. The
 * memecoin features (breadth, flow, boost share) come from this bot's own scanning history and have
 * no public backfill, so they cannot be replayed. What this measures is the backbone -- and if the
 * backbone is at chance, the rest has to carry the entire feature.
 */
import * as https from 'https';
import {
    Direction,
    ResolvedPrediction,
    predictSolDirection,
    scorePrediction,
    summariseAccuracy,
} from '../src/reporting/sol-prediction';

const HORIZON_MIN = 30;
const FLAT_BAND_PCT = 0.5;
const PREDICT_EVERY_MIN = 15;
const MINUTE = 60_000;

interface Point {
    at: number;
    price: number;
}

function get<T>(host: string, path: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = https.get(
            {
                host,
                path,
                family: 4,
                timeout: 25000,
                // CoinGecko rejects requests without a user agent.
                headers: { accept: 'application/json', 'user-agent': 'curl/8' },
            },
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

async function fromBinance(hours: number): Promise<Point[]> {
    const minutes = hours * 60;
    const out: Point[] = [];
    let endTime = Date.now();

    while (out.length < minutes) {
        const limit = Math.min(1000, minutes - out.length);
        const rows = await get<Array<[number, string, string, string, string]>>(
            'api.binance.com',
            `/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=${limit}&endTime=${endTime}`,
        );
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const r of rows) {
            const price = Number.parseFloat(r[4]);
            if (Number.isFinite(price) && price > 0) out.push({ at: r[0], price });
        }
        endTime = rows[0][0] - MINUTE;
        if (rows.length < limit) break;
        await sleep(250);
    }
    return out;
}

async function fromCoinGecko(): Promise<Point[]> {
    // Pinned to one day on purpose. CoinGecko switches to hourly buckets for any longer range, and
    // an hourly series cannot say anything useful about a thirty-minute horizon. One day at
    // five-minute granularity is the finest public history reachable without an API key.
    const res = await get<{ prices?: Array<[number, number]> }>(
        'api.coingecko.com',
        '/api/v3/coins/solana/market_chart?vs_currency=usd&days=1',
    );
    return (res?.prices ?? [])
        .filter(([at, price]) => Number.isFinite(at) && Number.isFinite(price) && price > 0)
        .map(([at, price]) => ({ at, price }));
}

/** Last observation at or before `target`, and undefined when the series does not reach back. */
function priceAt(series: Point[], target: number, toleranceMs: number): number | undefined {
    if (series.length === 0 || target < series[0].at - toleranceMs) return undefined;

    let lo = 0;
    let hi = series.length - 1;
    let best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (series[mid].at <= target) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best < 0) return undefined;
    // A gap wider than tolerance means the "lookback" would silently span the wrong interval.
    if (target - series[best].at > toleranceMs) return undefined;
    return series[best].price;
}

function changePct(series: Point[], now: Point, minutesAgo: number, tol: number): number | undefined {
    const then = priceAt(series, now.at - minutesAgo * MINUTE, tol);
    if (then === undefined || !(then > 0)) return undefined;
    return ((now.price - then) / then) * 100;
}

function volatilityPct(series: Point[], index: number, lookback: number): number | undefined {
    const start = Math.max(1, index - lookback + 1);
    if (index - start < 3) return undefined;
    const returns: number[] = [];
    for (let k = start; k <= index; k += 1) {
        const prev = series[k - 1].price;
        if (prev > 0) returns.push(((series[k].price - prev) / prev) * 100);
    }
    if (returns.length < 3) return undefined;
    const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
    const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
}

async function main() {
    const hours = Number.parseInt(process.argv[2] || '', 10) || 72;

    let series: Point[] = [];
    let source = '';
    // Binance and Kraken are DNS-hijacked to an ISP block page on this network -- the TLS error is
    // "cert altnames: internetsehatku.com", not a real certificate problem. Tried first anyway
    // because their one-minute series is far better when the network allows it.
    for (const [name, fn] of [
        ['Binance 1m', () => fromBinance(hours)],
        ['CoinGecko 5m', () => fromCoinGecko()],
    ] as const) {
        try {
            console.log(`Mencoba ${name}...`);
            series = await fn();
            if (series.length >= 100) {
                source = name;
                break;
            }
            console.log(`  hanya ${series.length} titik, lanjut ke sumber berikutnya`);
        } catch (error) {
            console.log(`  gagal: ${(error as Error).message}`);
        }
    }

    if (series.length < 100) {
        console.log('\nTidak ada sumber harga yang bisa dipakai. Backtest tidak bisa dijalankan.');
        process.exit(1);
    }

    series.sort((a, b) => a.at - b.at);
    const stepMs = series.length > 1 ? series[1].at - series[0].at : MINUTE;
    // Half a step of slack, so a lookback never silently lands on the wrong bucket.
    const tolerance = Math.max(MINUTE, stepMs * 1.5);

    console.log(
        `\n${series.length} titik dari ${source}, interval ~${Math.round(stepMs / 1000)}s` +
            `\n${new Date(series[0].at).toISOString().slice(0, 16)} -> ` +
            `${new Date(series[series.length - 1].at).toISOString().slice(0, 16)} UTC\n`,
    );

    const resolved: ResolvedPrediction[] = [];
    const directionCount: Record<Direction, number> = { UP: 0, DOWN: 0, FLAT: 0 };
    let skippedNoFeatures = 0;
    let lastPredictAt = 0;

    for (let i = 0; i < series.length; i += 1) {
        const point = series[i];
        if (point.at - lastPredictAt < PREDICT_EVERY_MIN * MINUTE) continue;

        const future = priceAt(series, point.at + HORIZON_MIN * MINUTE, tolerance);
        if (future === undefined) continue;

        const prediction = predictSolDirection(
            {
                solChange5mPct: changePct(series, point, 5, tolerance),
                solChange15mPct: changePct(series, point, 15, tolerance),
                solChange60mPct: changePct(series, point, 60, tolerance),
                solVolatilityPct: volatilityPct(series, i, Math.max(6, Math.round(1_800_000 / stepMs))),
            },
            { flatBandPct: FLAT_BAND_PCT },
        );

        lastPredictAt = point.at;

        // The buffer-too-short case, which is exactly what the guard exists for.
        if (!prediction) {
            skippedNoFeatures += 1;
            continue;
        }

        directionCount[prediction.direction] += 1;
        resolved.push({
            direction: prediction.direction,
            confidence: prediction.confidence,
            actualChangePct: ((future - point.price) / point.price) * 100,
            madeAt: point.at,
        });
    }

    if (resolved.length < 20) {
        console.log(`Hanya ${resolved.length} prediksi terbentuk. Terlalu sedikit untuk disimpulkan.`);
        process.exit(1);
    }

    const summary = summariseAccuracy(resolved, FLAT_BAND_PCT);

    console.log('=== HASIL BACKTEST ===\n');
    console.log(`Prediksi dinilai        : ${summary.total}`);
    console.log(`Dilewati (fitur kurang) : ${skippedNoFeatures}`);
    console.log(
        `Sebaran arah            : UP ${directionCount.UP} · DOWN ${directionCount.DOWN} · FLAT ${directionCount.FLAT}\n`,
    );
    console.log(
        `Akurasi model           : ${summary.hitRate.toFixed(1)}%  (${summary.correct}/${summary.total})`,
    );
    console.log(`Baseline "selalu FLAT"  : ${summary.baselineAlwaysFlat.toFixed(1)}%`);
    console.log(`Baseline "lanjut arah"  : ${summary.baselinePersistence.toFixed(1)}%\n`);

    console.log('Per keyakinan:');
    for (const level of ['strong', 'medium', 'weak'] as const) {
        const b = summary.byConfidence[level];
        console.log(`  ${level.padEnd(7)} n=${String(b.total).padStart(4)}  ${b.hitRate.toFixed(1)}%`);
    }

    // Sanity: a grader that never fires would look like a perfect model.
    const sanity = resolved.filter((r) =>
        scorePrediction({
            direction: r.direction,
            changePct: r.actualChangePct,
            flatBandPct: FLAT_BAND_PCT,
        }),
    ).length;
    console.log(`\n(cek konsistensi penilai: ${sanity} == ${summary.correct})`);

    const best = Math.max(summary.baselineAlwaysFlat, summary.baselinePersistence);
    const edge = summary.hitRate - best;
    console.log('\n=== VONIS ===');
    console.log(`Selisih terhadap baseline terbaik: ${edge >= 0 ? '+' : ''}${edge.toFixed(1)} poin`);
    if (edge > 3) {
        console.log('Mengalahkan kedua baseline. Layak dikirim, dengan akurasi tetap dicetak.');
    } else if (edge > -3) {
        console.log('Setara baseline. Momentum SOL saja belum membuktikan apa pun.');
    } else {
        console.log('Di bawah baseline. Momentum SOL saja tidak berguna untuk arah.');
    }
    console.log(
        '\nCatatan: hanya bagian momentum SOL yang diuji. Fitur memecoin (breadth, aliran volume,\n' +
            'boost) berasal dari riwayat pemindaian bot sendiri dan tidak punya backfill publik.',
    );
    process.exit(0);
}

void main();
