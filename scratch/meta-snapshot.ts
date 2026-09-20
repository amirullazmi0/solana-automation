/**
 * A one-shot snapshot of which meta is running right now.
 *
 *   npx ts-node -r tsconfig-paths/register scratch/meta-snapshot.ts
 *
 * Runs the activity half of MetaTrendService against live data without a database: it pulls the
 * same DexScreener feeds the scanner polls, resolves names and five-minute volume, labels them
 * through the real batch labeller, and ranks the labels the same way computeHeat does.
 *
 * The P&L half is deliberately absent. It needs closed trades carrying a metaLabel, which only the
 * running bot produces -- so this answers "what is busy" and explicitly not "what is profitable".
 */
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import { AIService } from '../src/ai/ai.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { MetaLabelRequest, UNLABELED } from '../src/meta/meta-label';
import { MetaAggregate, computeHeat } from '../src/meta/meta-trend';
import { loadRuntimeConfig } from '../src/config/runtime-config';

interface DexPair {
    chainId: string;
    baseToken?: { address?: string; name?: string; symbol?: string };
    volume?: { m5?: number; h24?: number };
    liquidity?: { usd?: number };
}

function get<T>(host: string, path: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = https.get(
            { host, path, family: 4, timeout: 20000, headers: { accept: 'application/json' } },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data || 'null') as T);
                    } catch (error) {
                        reject(error as Error);
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

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function main() {
    const runtime = loadRuntimeConfig();
    const readConfig = <T>(key: string, fallback?: T): T => {
        const value = process.env[key] ?? (runtime as Record<string, unknown>)[key];
        return (value === undefined ? fallback : value) as T;
    };
    const configService = { get: readConfig } as unknown as ConfigService;

    // Both feeds, tracked separately: token-boosts is PAID promotion while token-profiles is
    // closer to organic. Conflating them would let anyone with a marketing budget decide what
    // "the live meta" is.
    const boosted = new Set<string>();
    const mints = new Set<string>();
    for (const path of ['/token-boosts/latest/v1', '/token-profiles/latest/v1']) {
        const feed = await get<Array<{ chainId: string; tokenAddress: string }>>(
            'api.dexscreener.com',
            path,
        );
        for (const item of feed || []) {
            if (item.chainId !== 'solana' || !item.tokenAddress) continue;
            mints.add(item.tokenAddress);
            if (path.includes('boosts')) boosted.add(item.tokenAddress);
        }
        await sleep(300);
    }

    console.log(`Discovery: ${mints.size} mint unik (${boosted.size} berbayar/boosted)\n`);

    // DexScreener takes up to 30 comma-separated addresses per call.
    const all = [...mints];
    const tokens = new Map<string, { name: string; symbol: string; vol5m: number; liq: number }>();
    for (let i = 0; i < all.length; i += 30) {
        const chunk = all.slice(i, i + 30);
        const res = await get<{ pairs: DexPair[] }>(
            'api.dexscreener.com',
            `/latest/dex/tokens/${chunk.join(',')}`,
        );
        for (const pair of res?.pairs || []) {
            const address = pair.baseToken?.address;
            if (!address || pair.chainId !== 'solana') continue;
            const name = pair.baseToken?.name || pair.baseToken?.symbol || '';
            if (!name) continue;
            // Several pairs per token: keep the deepest, which is the one the analyzer would pick.
            const existing = tokens.get(address);
            const liq = pair.liquidity?.usd || 0;
            if (existing && existing.liq >= liq) continue;
            tokens.set(address, {
                name,
                symbol: pair.baseToken?.symbol || '',
                vol5m: pair.volume?.m5 || 0,
                liq,
            });
        }
        await sleep(400);
    }

    console.log(`Nama terselesaikan untuk ${tokens.size} token. Melabeli...\n`);

    const aiService = new AIService(configService, {} as PrismaService);
    const batchSize = Number.parseInt(String(readConfig('META_LABEL_BATCH_SIZE', '40')), 10);
    const entries = [...tokens.entries()];
    const labels = new Map<string, string>();
    const vocabulary: string[] = [];
    let requests = 0;
    let tokensIn = 0;
    let tokensOut = 0;

    for (let i = 0; i < entries.length; i += batchSize) {
        const slice = entries.slice(i, i + batchSize);
        const items: MetaLabelRequest[] = slice.map(([mint, t]) => ({
            tokenMint: mint,
            tokenName: t.name,
            symbol: t.symbol,
        }));

        const result = await aiService.labelMetas(items, vocabulary);
        if (!result) {
            console.log('  (batch gagal, dilewati)');
            continue;
        }
        requests += 1;
        tokensIn += result.promptTokens;
        tokensOut += result.completionTokens;

        for (const record of result.records) {
            labels.set(record.tokenMint, record.label);
            // Feed the vocabulary forward between batches, exactly as MetaLabelService does. Without
            // it the model coins a fresh spelling per batch and one meta splits into several.
            if (record.label !== UNLABELED && !vocabulary.includes(record.label)) {
                vocabulary.push(record.label);
            }
        }
    }

    const byLabel = new Map<string, MetaAggregate>();
    for (const [mint, token] of tokens) {
        const label = labels.get(mint);
        if (!label || label === UNLABELED) continue;
        const entry = byLabel.get(label) ?? {
            label,
            sightings: 0,
            volumeSum: 0,
            boostCount: 0,
            trades: 0,
            netPnlTotal: 0,
        };
        entry.sightings += 1;
        entry.volumeSum += token.vol5m;
        if (boosted.has(mint)) entry.boostCount += 1;
        byLabel.set(label, entry);
    }

    const heat = computeHeat([...byLabel.values()]);
    const rows = [...heat.values()]
        .sort((a, b) => b.heatScore - a.heatScore)
        .map((entry) => {
            const aggregate = byLabel.get(entry.label)!;
            return {
                meta: entry.label,
                tier: entry.tier,
                heat: entry.heatScore.toFixed(0),
                token: aggregate.sightings,
                vol5m: `$${Math.round(aggregate.volumeSum).toLocaleString('en-US')}`,
                boosted: aggregate.boostCount,
            };
        });

    console.log('=== META YANG SEDANG JALAN ===\n');
    console.table(rows);

    const unlabelled = [...tokens.keys()].filter(
        (m) => !labels.has(m) || labels.get(m) === UNLABELED,
    ).length;
    console.log(`\nTanpa tema: ${unlabelled} dari ${tokens.size} token`);
    console.log(
        `Biaya: ${requests} request, ${tokensIn} token in / ${tokensOut} out ` +
            `(${((tokensIn + tokensOut) / Math.max(tokens.size, 1)).toFixed(1)} per token)`,
    );
    console.log(
        '\nCatatan: ini setengah AKTIVITAS dari heat score. Bagian P&L butuh trade tertutup ' +
            'yang membawa metaLabel, jadi ranking ini "apa yang ramai", bukan "apa yang cuan".',
    );
    process.exit(0);
}

void main();
