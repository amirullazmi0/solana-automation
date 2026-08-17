/**
 * Cross-checks the Helius swap classifier against DexScreener for the same pool.
 *
 * DexScreener independently reports `txns.h1.buys` / `txns.h1.sells`. This script derives the same
 * split from parsed Helius transactions via `classifySwap`, then compares the two. If the buy
 * SHARE agrees within a few points, the classifier is reading trade direction correctly and its
 * volume split can be trusted. If it disagrees, ENABLE_H1_FLOW_VOLUME must stay off.
 *
 *   npx ts-node -r tsconfig-paths/register scratch/flow-volume-verify.ts [mint ...]
 *
 * With no arguments it picks the busiest tokens from DexScreener's boost feed.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import { FlowVolumeService } from '../src/analyzer/flow-volume.service';
import { loadRuntimeConfig } from '../src/config/runtime-config';

interface DexPair {
    pairAddress?: string;
    baseToken?: { address?: string; symbol?: string };
    liquidity?: { usd?: number };
    volume?: { h1?: number };
    txns?: { h1?: { buys?: number; sells?: number } };
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

async function discover(): Promise<string[]> {
    const boosts = await get<{ tokenAddress?: string; chainId?: string }[]>(
        'api.dexscreener.com',
        '/token-boosts/latest/v1',
    );
    return (boosts || [])
        .filter((b) => b.chainId === 'solana' && b.tokenAddress)
        .map((b) => b.tokenAddress as string)
        .slice(0, 25);
}

async function main(): Promise<void> {
    const runtime = loadRuntimeConfig();
    const env = process.env;
    const configService = {
        get: <T>(key: string, fallback?: T): T => {
            const value = env[key] ?? (runtime as Record<string, unknown>)[key];
            return (value === undefined ? fallback : value) as T;
        },
    } as unknown as ConfigService;

    const flow = new FlowVolumeService(configService);
    const mints = process.argv.slice(2).length ? process.argv.slice(2) : await discover();

    console.log(`Memverifikasi ${mints.length} token...\n`);
    const rows: string[] = [];
    let agree = 0;
    let compared = 0;

    for (const mint of mints) {
        await sleep(600); // stay inside DexScreener's budget
        let pair: DexPair | undefined;
        try {
            const res = await get<{ pairs?: DexPair[] }>(
                'api.dexscreener.com',
                `/latest/dex/tokens/${mint}`,
            );
            pair = (res?.pairs || [])
                .filter((p) => p.baseToken?.address === mint && p.pairAddress)
                .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        } catch {
            continue;
        }
        if (!pair?.pairAddress) continue;

        const dexBuys = pair.txns?.h1?.buys || 0;
        const dexSells = pair.txns?.h1?.sells || 0;
        // Too little flow to compare meaningfully, and paginating 3 pages would not help.
        if (dexBuys + dexSells < 30) continue;

        const t0 = Date.now();
        const result = await flow.getHourlyFlowVolume(mint, pair.pairAddress);
        const elapsed = Date.now() - t0;
        const symbol = (pair.baseToken?.symbol || mint.slice(0, 6)).slice(0, 12);

        if (!result || result.sampled === 0) {
            rows.push(`${symbol.padEnd(13)} dex=${dexBuys}/${dexSells}  helius=GAGAL  ${elapsed}ms`);
            continue;
        }

        const dexShare = (100 * dexBuys) / (dexBuys + dexSells);
        const heliusShare = (100 * result.buyCount) / (result.buyCount + result.sellCount || 1);
        const volShare =
            (100 * result.buyVolumeSol) / (result.buyVolumeSol + result.sellVolumeSol || 1);
        const diff = Math.abs(dexShare - heliusShare);
        compared += 1;
        if (diff <= 10) agree += 1;

        rows.push(
            `${symbol.padEnd(13)} ` +
                `dex=${dexShare.toFixed(1).padStart(5)}% (${dexBuys}/${dexSells})  ` +
                `helius=${heliusShare.toFixed(1).padStart(5)}% (${result.buyCount}/${result.sellCount})  ` +
                `selisih=${diff.toFixed(1).padStart(5)}pp  ` +
                `volShare=${volShare.toFixed(1).padStart(5)}%  ` +
                `vol=${result.buyVolumeSol.toFixed(2)}/${result.sellVolumeSol.toFixed(2)} SOL  ` +
                `${String(elapsed).padStart(6)}ms`,
        );
    }

    console.log(rows.join('\n'));
    console.log(`\n=== KESIMPULAN ===`);
    console.log(`  token dibandingkan       : ${compared}`);
    if (compared > 0) {
        console.log(
            `  sepakat (selisih <=10pp) : ${agree}/${compared} (${((100 * agree) / compared).toFixed(0)}%)`,
        );
        console.log(
            agree / compared >= 0.7
                ? '  -> klasifikasi TERVERIFIKASI, ENABLE_H1_FLOW_VOLUME layak dinyalakan'
                : '  -> klasifikasi TIDAK COCOK, biarkan ENABLE_H1_FLOW_VOLUME tetap false',
        );
    }
}

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
