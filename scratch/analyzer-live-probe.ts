/**
 * Runs the REAL AnalyzerService.isTokenSafeToBuy() against live tokens, with the database
 * stubbed out, so the full gate chain (DexScreener traction -> mint RPC -> RugCheck -> LP ->
 * route/signal) can be exercised locally without touching a Prisma schema.
 *
 *   npx ts-node -r tsconfig-paths/register scratch/analyzer-live-probe.ts [mint ...]
 *
 * With no arguments it pulls candidates from the same DexScreener discovery feeds the scanner
 * polls.
 */
import { ConfigService } from '@nestjs/config';
import * as https from 'https';
import { AnalyzerService } from '../src/analyzer/analyzer.service';
import { FlowVolumeService } from '../src/analyzer/flow-volume.service';
import { loadRuntimeConfig } from '../src/config/runtime-config';
import { CreatorProfileService } from '../src/analyzer/creator-profile.service';
import { AIService } from '../src/ai/ai.service';
import { PrismaService } from '../src/prisma/prisma.service';

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

async function discover(): Promise<string[]> {
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
    return [...mints];
}

async function main() {
    const runtime = loadRuntimeConfig();
    const env = process.env;
    const configService = {
        get: <T>(key: string, fallback?: T): T => {
            const value = env[key] ?? (runtime as Record<string, unknown>)[key];
            return (value === undefined ? fallback : value) as T;
        },
    } as unknown as ConfigService;

    // Only the members AnalyzerService actually touches.
    const prismaService = {
        tokenSafetyProbe: { findFirst: async () => null },
    } as unknown as PrismaService;
    const creatorProfileService = {
        evaluateCreator: async () => ({
            address: '',
            tokensCreated: 1,
            ruggedTokens: 0,
            riskScore: 0,
            isBlacklisted: false,
        }),
    } as unknown as CreatorProfileService;
    const aiService = {} as AIService;

    const flowVolumeService = new FlowVolumeService(configService);

    const analyzer = new AnalyzerService(
        configService,
        prismaService,
        creatorProfileService,
        aiService,
        flowVolumeService,
    );

    const mints = process.argv.slice(2).length ? process.argv.slice(2) : await discover();
    console.log(`\nMenguji ${mints.length} token lewat AnalyzerService.isTokenSafeToBuy() asli\n`);

    const tally = new Map<string, number>();
    const passed: Array<Record<string, unknown>> = [];

    for (const mint of mints) {
        let result: Awaited<ReturnType<AnalyzerService['isTokenSafeToBuy']>>;
        try {
            result = await analyzer.isTokenSafeToBuy(mint);
        } catch (error) {
            result = { safe: false, reason: `threw:${(error as Error).message}` };
        }
        const key = result.safe ? '✅ SAFE' : (result.reason ?? 'unknown');
        tally.set(key, (tally.get(key) ?? 0) + 1);
        if (result.safe) {
            passed.push({
                mint,
                sym: result.metadata?.symbol,
                route: result.metadata?.route,
                liq: Math.round(result.metadata?.liquidity ?? 0),
                mcap: Math.round(result.metadata?.mcap ?? 0),
                score: result.metadata?.whaleSignalScore,
            });
            console.log(`  ✅ ${result.metadata?.symbol ?? mint} LOLOS SEMUA GATE (${mint})`);
        }
        await sleep(400);
    }

    console.log('\n=== HASIL ===');
    for (const [reason, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`${String(count).padStart(4)}  ${reason}`);
    }
    if (passed.length) {
        console.log('\n=== KANDIDAT BUY ===');
        console.table(passed);
    }
    console.log(`\nTotal: ${mints.length} | Lolos: ${passed.length}`);
}

void main();
