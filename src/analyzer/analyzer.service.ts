import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import axios from 'axios';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { DexLimiter } from '../common/dex-limiter';
import { CreatorProfileService } from './creator-profile.service';
import { AIService } from '../ai/ai.service';
import {
    CreatorOwnershipResult,
    DexScreenerPair,
    RugCheckApiHolder,
    RugCheckApiResponse,
    RugCheckHolder,
    RugCheckMarket,
    RugCheckResponse,
    RugCheckRisk,
    TokenMetadata,
} from '../dto/analyzer.dto';

@Injectable()
export class AnalyzerService {
    private readonly logger = new Logger(AnalyzerService.name);
    private readonly connection: Connection;
    private readonly jupiterApiKey: string;
    private readonly ipCache: Record<string, string> = {};
    private creatorRpcFailureCount = 0;

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly creatorProfileService: CreatorProfileService,
        private readonly aiService: AIService,
    ) {
        const rpcEndpoint =
            this.configService.get<string>('RPC_ENDPOINT') || 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(rpcEndpoint, 'confirmed');
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
    }

    /**
     * Safety filter to check if token is safe and trending.
     */
    async isTokenSafeToBuy(
        tokenMint: string,
    ): Promise<{ safe: boolean; metadata?: TokenMetadata; reason?: string; permanent?: boolean }> {
        try {
            // 1. DEXSCREENER (Traction & Metrics)
            const traction = await this.checkMarketTraction(tokenMint);

            const baseMetadata: TokenMetadata = {
                liquidity: traction.liquidity || 0,
                marketCap: traction.marketCap || 0,
                mcap: traction.marketCap,
                pairCreatedAt: traction.pairCreatedAt,
                symbol: traction.symbol,
                socials: traction.socials,
                volumeSurge: traction.volumeSurge,
                volScore: traction.volScore,
                zScore: traction.zScore,
                priceChange1h: traction.priceChange1h,
                isPumpFun: traction.isPumpFun,
            };

            if (!traction.passed) {
                return {
                    safe: false,
                    reason: traction.reason || 'low_traction',
                    permanent: traction.permanent,
                    metadata: baseMetadata,
                };
            }

            // 🛡️ ADVANCED METRICS CHECK
            // 1. VoL Check (Min 0.05 untuk koin breakout)
            const minVolScore = Number.parseFloat(
                this.configService.get<string>('ANALYZER_MIN_VOL_SCORE', '0.05'),
            );
            if (traction.volScore && traction.volScore < minVolScore) {
                this.logger.debug(
                    `[${tokenMint}] Low VoL Score: ${traction.volScore.toFixed(4)}. Supply not shocked enough.`,
                );
                return { safe: false, reason: 'low_vol_score', metadata: baseMetadata };
            }

            // 2. Z-Score Anomaly Check (Z > 2.5 is anomaly)
            const minZScore = Number.parseFloat(
                this.configService.get<string>('ANALYZER_MIN_Z_SCORE', '2.5'),
            );
            if (traction.zScore && traction.zScore < minZScore) {
                this.logger.debug(
                    `[${tokenMint}] Normal Volume (Z-Score: ${traction.zScore.toFixed(2)}). Waiting for anomaly...`,
                );
                return { safe: false, reason: 'no_volume_anomaly', metadata: baseMetadata };
            }

            // 2. RPC CHECK (Security) — With PumpFun tolerance
            const isPumpFunToken = tokenMint.toLowerCase().endsWith('pump');
            const safetyRpc = await this.checkTokenSecurityRPC(tokenMint, isPumpFunToken);
            if (!safetyRpc.passed) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 Safety RPC check FAILED (Freeze/Mint authority). Skip.`,
                );
                return {
                    safe: false,
                    reason: 'safety_rpc_failed',
                    permanent: safetyRpc.permanent,
                    metadata: baseMetadata,
                };
            }

            // 3. RUGCHECK (Advanced Safety Index & LP Burn)
            const rugResult = await this.checkRugCheckAPI(tokenMint);
            if (!rugResult.passed) {
                this.logger.warn(`[${tokenMint}] 🛑 RugCheck FAILED: ${rugResult.reason}. Skip.`);
                return {
                    safe: false,
                    reason: rugResult.reason || 'rugcheck_failed',
                    permanent: rugResult.permanent,
                    metadata: baseMetadata,
                };
            }

            // 🧑‍💻 CREATOR PROFILE CHECK (Anti-Rug)
            if (rugResult.creator) {
                const profile = await this.creatorProfileService.evaluateCreator(rugResult.creator);

                if (profile.isBlacklisted || profile.riskScore >= 80) {
                    this.logger.warn(
                        `[${tokenMint}] 🛑 Creator ${rugResult.creator} is blacklisted or high risk (Score: ${profile.riskScore}). Skip.`,
                    );
                    return {
                        safe: false,
                        reason: 'creator_high_risk',
                        permanent: true,
                        metadata: baseMetadata,
                    };
                }
            }

            const openAiKey = this.configService.get<string>('OPENAI_API_KEY') || '';
            const shouldUseAi =
                openAiKey.length > 0 &&
                !openAiKey.includes('your-openai-api-key') &&
                !openAiKey.includes('your_');
            if (shouldUseAi) {
                const aiThreshold = Number.parseFloat(
                    this.configService.get<string>('AI_CONVICTION_THRESHOLD', '75.0'),
                );
                const aiResult = await this.aiService.analyzeToken(
                    tokenMint,
                    traction.symbol || 'UNKNOWN',
                    {
                        ageHours: traction.pairCreatedAt
                            ? (Date.now() - traction.pairCreatedAt) / (1000 * 60 * 60)
                            : 0,
                        liquidityUsd: traction.liquidity || 0,
                        marketCapUsd: traction.marketCap || 0,
                        volume5mUsd: traction.volume5m || 0,
                        buys5mCount: traction.buys5m || 0,
                        sells5mCount: traction.sells5m || 0,
                        priceChange1hPct: traction.priceChange1h || 0,
                        isPumpFun: traction.isPumpFun || false,
                        rugcheckScore: rugResult.rugcheckScore,
                        dangerRisksCount: rugResult.dangerRisksCount,
                        creatorHoldPct: rugResult.creatorHoldPct,
                        top10HolderPct: rugResult.top10HolderPct,
                        safetyIndex: rugResult.safetyIndex,
                        volumeSurge: traction.volumeSurge,
                        volScore: traction.volScore,
                        zScore: traction.zScore,
                    },
                );

                if (aiResult.action !== 'buy' || aiResult.cuanConvictionScore < aiThreshold) {
                    this.logger.debug(
                        `[${tokenMint}] AI rejected signal. Score=${aiResult.cuanConvictionScore}, Threshold=${aiThreshold}, Action=${aiResult.action}.`,
                    );
                    return {
                        safe: false,
                        reason: 'ai_rejected',
                        metadata: baseMetadata,
                    };
                }
            }

            this.logger.log(
                `[${tokenMint}] ✅ Passed Advanced Filters (VoL: ${traction.volScore?.toFixed(3)}, Z: ${traction.zScore?.toFixed(1)}, Safety: ${rugResult.safetyIndex?.toFixed(2)}, isCTO: ${rugResult.isCTO}). Ready!`,
            );
            return {
                safe: true,
                metadata: {
                    ...baseMetadata,
                    creator: rugResult.creator,
                    topHolder: rugResult.topHolder,
                    isCTO: rugResult.isCTO,
                },
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] Analysis failed: ${msg}`);
            return { safe: false, reason: 'error' };
        }
    }

    async getTokenMetadata(tokenMint: string): Promise<TokenMetadata> {
        const traction = await this.checkMarketTraction(tokenMint);
        return {
            liquidity: traction.liquidity || 0,
            marketCap: traction.marketCap || 0,
            mcap: traction.marketCap,
            pairCreatedAt: traction.pairCreatedAt,
            symbol: traction.symbol,
            socials: traction.socials,
            volumeSurge: traction.volumeSurge,
        };
    }

    private async getJupiterPrice(tokenMint: string): Promise<number | null> {
        try {
            const response = await axios.get(`https://api.jup.ag/price/v3?ids=${tokenMint}`, {
                timeout: 3000,
                headers: { 'x-api-key': this.jupiterApiKey },
                httpsAgent: this.getHttpsAgent(),
            });
            const data = response.data as Record<string, { usdPrice?: number } | undefined> | null;
            return data?.[tokenMint]?.usdPrice || null;
        } catch {
            return null;
        }
    }

    private async checkTokenSecurityRPC(
        tokenMint: string,
        isPumpFun = false,
    ): Promise<{ passed: boolean; permanent: boolean }> {
        const mintPublicKey = new PublicKey(tokenMint);
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const accountInfo = await this.connection.getAccountInfo(mintPublicKey);
                if (!accountInfo) {
                    throw new Error('Mint account not found on-chain');
                }
                const mintInfo = await getMint(
                    this.connection,
                    mintPublicKey,
                    undefined,
                    accountInfo.owner,
                );

                // Mint authority HARUS null (tidak boleh cetak token baru)
                if (mintInfo.mintAuthority !== null) {
                    this.logger.warn(`[${tokenMint}] Mint authority still active. Reject.`);
                    return { passed: false, permanent: true };
                }

                // Freeze authority: PumpFun tokens sering punya freeze auth sementara post-migration
                if (mintInfo.freezeAuthority !== null) {
                    if (isPumpFun) {
                        this.logger.debug(
                            `[${tokenMint}] ⚠️ Freeze authority active but PumpFun token — TOLERATED.`,
                        );
                        return { passed: true, permanent: false }; // PumpFun tolerance
                    }
                    this.logger.warn(
                        `[${tokenMint}] Freeze authority active (non-PumpFun). Reject.`,
                    );
                    return { passed: false, permanent: true };
                }

                return { passed: true, permanent: false }; // Both null = safe
            } catch (e) {
                const errName = e instanceof Error ? e.name || e.message : String(e);
                this.logger.warn(
                    `[${tokenMint}] Mint authority check failed (attempt ${attempt}/${maxRetries}): ${errName}`,
                );
                if (attempt < maxRetries) {
                    await new Promise((res) => setTimeout(res, 1000 * attempt));
                }
            }
        }
        return { passed: false, permanent: false }; // All retries failed (probably temporary RPC error)
    }

    private async checkMarketTraction(tokenMint: string): Promise<{
        passed: boolean;
        liquidity?: number;
        marketCap?: number;
        velocity?: number;
        socials?: TokenMetadata['socials'];
        reason?: string;
        permanent?: boolean;
        symbol?: string;
        pairCreatedAt?: number;
        volumeSurge?: number;
        volScore?: number;
        zScore?: number;
        priceChange1h?: number;
        isPumpFun?: boolean;
        volume5m?: number;
        buys5m?: number;
        sells5m?: number;
    }> {
        try {
            const minLiq = Number.parseFloat(
                this.configService.get<string>('MIN_LIQUIDITY_USD', '7500'),
            );
            const minVol = Number.parseFloat(
                this.configService.get<string>('MIN_VOLUME_USD', '200'),
            );
            const minBuys = Number.parseInt(this.configService.get<string>('MIN_BUY_COUNT', '3'));
            const minVelocity = Number.parseFloat(
                this.configService.get<string>('MIN_VOLUME_MCAP_RATIO', '0.02'),
            );
            const minVlRatio = Number.parseFloat(
                this.configService.get<string>('MIN_VL_RATIO', '0'),
            );
            const minMCap = Number.parseFloat(this.configService.get<string>('MIN_MCAP', '5000'));
            const maxMCap = Number.parseFloat(this.configService.get<string>('MAX_MCAP', '300000'));
            const minAge = Number.parseFloat(
                this.configService.get<string>('MIN_AGE_HOURS', '0.02'),
            );
            const minConfidence = Number.parseFloat(
                this.configService.get<string>('MIN_BUY_CONFIDENCE', '0.60'),
            );

            const response = await DexLimiter.get<{ pairs: DexScreenerPair[] }>(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                {
                    timeout: 5000,
                    httpsAgent: this.getHttpsAgent(),
                },
            );

            const pair = response.data.pairs?.[0];
            if (!pair) return { passed: false, reason: 'no_dex_pair', permanent: false };

            const liquidity = pair.liquidity?.usd || 0;
            const volume5m = pair.volume?.m5 || 0;
            const volumeH1 = pair.volume?.h1 || 0;
            const txns5m = pair.txns?.m5 || {};
            const buys5m = txns5m.buys || 0;
            const sells5m = txns5m.sells || 0;
            const marketCap = pair.fdv || 0;
            const symbol = pair.baseToken?.symbol;
            const pairCreatedAt = pair.pairCreatedAt || 0;
            const socials = {
                twitter: pair.info?.socials?.find((s) => s.type === 'twitter')?.url,
                telegram: pair.info?.socials?.find((s) => s.type === 'telegram')?.url,
                website: pair.info?.websites?.[0]?.url,
            };

            // 🛡️ HARD REJECT: Token tanpa liquidity = impossible to sell tanpa massive slippage
            if (!liquidity || liquidity < 1000) {
                const isYoung = Date.now() - (pair.pairCreatedAt || 0) < 1000 * 60 * 60; // < 1 hour
                return {
                    passed: false,
                    reason: 'zero_liquidity',
                    permanent: !isYoung, // Hanya permanent kalau koin sudah lama tapi likuiditas tetep 0
                    liquidity,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                };
            }

            // 🚀 EARLY REJECT: Cek filter murah dulu sebelum kalkulasi mahal
            if (liquidity < minLiq) {
                return {
                    passed: false,
                    reason: 'low_metrics',
                    liquidity,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                };
            }
            if (volume5m < minVol) {
                return {
                    passed: false,
                    reason: 'low_metrics',
                    liquidity,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                };
            }
            if (buys5m < minBuys) {
                return {
                    passed: false,
                    reason: 'low_metrics',
                    liquidity,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                };
            }

            // 1. VoL (Velocity of Liquidity)
            // Rumus: (Volume 5m / Liquidity) * Confidence Score
            const confidenceScore = buys5m / (buys5m + sells5m || 1);
            const vlRatio = volume5m / (liquidity || 1);
            const volScore = vlRatio * confidenceScore;

            // 2. Volume Z-Score (Anomaly Detection)
            // Pseudo Z-Score: (Current - Avg) / StdDev (Asumsi StdDev = Avg * 0.5)
            const avgVol5m = volumeH1 / 12;
            const zScore = (volume5m - avgVol5m) / (avgVol5m * 0.5 || 1);

            // 🚫 HONEYPOT DETECTION
            if (buys5m >= 10 && sells5m === 0) {
                return {
                    passed: false,
                    reason: 'honeypot',
                    permanent: true,
                    liquidity,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    volScore,
                    zScore,
                    priceChange1h: pair.priceChange?.h1 || 0,
                    isPumpFun:
                        pair.info?.websites?.some((w) => w.url.includes('pump.fun')) || false,
                };
            }

            const velocity = volume5m / (marketCap || 1);
            const isPumpFun = pair.info?.websites?.some((w) => w.url.includes('pump.fun')) || false;
            const priceChange1h = pair.priceChange?.h1 || 0;

            if (marketCap < minMCap || marketCap > maxMCap) {
                const isPerm = marketCap > maxMCap; // MCap kegedean baru permanent
                return {
                    passed: false,
                    reason: marketCap > maxMCap ? 'mcap_too_high' : 'mcap_too_low',
                    permanent: isPerm,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange1h,
                    isPumpFun,
                };
            }

            const ageHours = (Date.now() - (pair.pairCreatedAt || 0)) / (1000 * 60 * 60);
            const maxAge = Number.parseFloat(
                this.configService.get<string>('MAX_AGE_HOURS', '24.0'),
            );
            const establishedMaxAge = Number.parseFloat(
                this.configService.get<string>('ESTABLISHED_MAX_AGE_HOURS', '72.0'),
            );
            const absoluteMaxAge = Math.max(maxAge, establishedMaxAge);

            if (ageHours < minAge || ageHours > maxAge) {
                const isTooOld = ageHours > maxAge;
                const isPerm = isTooOld && ageHours > absoluteMaxAge;
                return {
                    passed: false,
                    reason: isTooOld ? 'too_old' : 'too_young',
                    permanent: isPerm,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange1h,
                    isPumpFun,
                };
            }

            const volumeSurge = volume5m / (avgVol5m || 1);
            const minSurge = Number.parseFloat(
                this.configService.get<string>('ANALYZER_MIN_VOLUME_SURGE', '1.5'),
            );
            if (volumeSurge < minSurge) {
                return {
                    passed: false,
                    reason: 'low_surge',
                    volumeSurge,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange1h,
                    isPumpFun,
                };
            }
            if (priceChange1h < -15) {
                return {
                    passed: false,
                    reason: 'bearish_trend',
                    permanent: true,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange1h,
                    isPumpFun,
                };
            }

            if (vlRatio < minVlRatio) {
                return {
                    passed: false,
                    reason: 'low_vl_ratio',
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange1h,
                    isPumpFun,
                    volume5m,
                    buys5m,
                    sells5m,
                };
            }

            // 📊 BUY VS SELL RATIO (Confidence Score)
            if (confidenceScore < minConfidence) {
                return {
                    passed: false,
                    reason: 'low_buy_confidence',
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange1h,
                    isPumpFun,
                };
            }

            if (velocity < minVelocity) {
                return {
                    passed: false,
                    reason: 'low_velocity',
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange1h,
                    isPumpFun,
                };
            }

            return {
                passed: true,
                liquidity,
                marketCap,
                velocity,
                socials,
                symbol,
                pairCreatedAt,
                volumeSurge,
                volScore,
                zScore,
                priceChange1h,
                isPumpFun,
                volume5m,
                buys5m,
                sells5m,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] Traction check failed: ${msg}`);
            return { passed: false };
        }
    }

    private async resolveDns(hostname: string): Promise<string> {
        if (this.ipCache[hostname]) return this.ipCache[hostname];
        try {
            let response = await axios
                .get(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
                    headers: { accept: 'application/dns-json' },
                    timeout: 5000,
                    httpsAgent: new https.Agent({ family: 4 }),
                })
                .catch(() => null);

            if (!response) {
                response = await axios
                    .get(`https://8.8.8.8/resolve?name=${hostname}&type=A`, {
                        timeout: 5000,
                        httpsAgent: new https.Agent({ family: 4 }),
                    })
                    .catch(() => null);
            }

            const ip = response?.data?.Answer?.[0]?.data;
            if (ip && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
                this.ipCache[hostname] = ip;
                return ip;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${hostname}] DNS resolution failed: ${msg}`);
        }
        return hostname;
    }

    private getHttpsAgent() {
        return new https.Agent({
            family: 4,
            keepAlive: true,
            lookup: async (hostname, options, cb) => {
                try {
                    const ip = await this.resolveDns(hostname);
                    if (ip) {
                        cb(null, ip, 4);
                    } else {
                        import('dns')
                            .then(({ lookup }) => {
                                lookup(hostname, options, cb);
                            })
                            .catch((err) => {
                                cb(err, '', 4);
                            });
                    }
                } catch (e) {
                    cb(e as Error, '', 4);
                }
            },
        });
    }

    public checkHolderConcentration(rugCheckData: RugCheckResponse): boolean {
        try {
            const top10Share = rugCheckData.holders
                .filter((holder: RugCheckHolder) => !holder.isInPool && !holder.isBurned)
                .slice(0, 10)
                .reduce((sum: number, holder: RugCheckHolder) => sum + holder.share, 0);

            if (top10Share > 20) {
                this.logger.warn(
                    `❌ REJECTED: Top 10 Holders menguasai ${top10Share.toFixed(2)}% supply. Terlalu pekat!`,
                );
                return false;
            }

            if (rugCheckData.score > 1000) {
                this.logger.warn(
                    `❌ REJECTED: RugCheck score ${rugCheckData.score} melewati batas 1000.`,
                );
                return false;
            }

            const dangerCount = rugCheckData.dangerReasons?.length || 0;
            if (dangerCount > 0) {
                this.logger.warn(
                    `❌ REJECTED: RugCheck danger risks detected (${rugCheckData.dangerReasons?.join(', ')}).`,
                );
                return false;
            }

            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Holder concentration check failed safely: ${msg}`);
            return false;
        }
    }

    private toRugCheckResponse(
        data: RugCheckApiResponse,
        holders: RugCheckApiHolder[],
        markets: RugCheckMarket[],
        risks: RugCheckRisk[],
    ): RugCheckResponse {
        const normalizedHolders = holders.map((holder: RugCheckApiHolder): RugCheckHolder => {
            const owner = holder.owner.toLowerCase();
            return {
                address: holder.address,
                amount: Number.isFinite(holder.amount) ? holder.amount : 0,
                share: Number.isFinite(holder.pct) ? holder.pct : 0,
                isInPool: owner.includes('pool') || owner.includes('amm'),
                isBurned: owner === '1111111111111111111111111111111',
            };
        });
        const topHoldersPercentage = normalizedHolders
            .filter((holder: RugCheckHolder) => !holder.isInPool && !holder.isBurned)
            .slice(0, 10)
            .reduce((sum: number, holder: RugCheckHolder) => sum + holder.share, 0);
        const dangerReasons = risks
            .filter((risk: RugCheckRisk) => risk.level === 'danger')
            .map((risk: RugCheckRisk) => risk.name);

        return {
            mint: data.mint || '',
            score: data.score || 0,
            meta: {
                topHoldersPercentage,
                totalHolders: normalizedHolders.length,
                lpBurned: markets.some(
                    (market: RugCheckMarket) =>
                        market.lpType === 'burned' || market.lpStatus === 'burned',
                ),
                lpLocked: markets.some(
                    (market: RugCheckMarket) =>
                        market.lpType === 'locked' || market.lpStatus === 'locked',
                ),
            },
            holders: normalizedHolders,
            dangerReasons,
        };
    }

    private async checkRugCheckAPI(tokenMint: string): Promise<{
        passed: boolean;
        creator?: string;
        topHolder?: string;
        reason?: string;
        safetyIndex?: number;
        rugcheckScore?: number;
        dangerRisksCount?: number;
        creatorHoldPct?: number;
        top10HolderPct?: number;
        permanent?: boolean;
        isCTO?: boolean;
    }> {
        try {
            const response = await axios.get<RugCheckApiResponse>(
                `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`,
                {
                    timeout: 5000,
                    httpsAgent: this.getHttpsAgent(),
                },
            );

            if (!response.data)
                return { passed: false, reason: 'rugcheck_no_data', permanent: false };

            const topHolders = response.data.topHolders || [];
            const knownAccounts = response.data.knownAccounts || {};

            // 🛡️ SAFETY & HOLDER INDEX (Anti-Rug) - Saring dompet AMM, lockers, dan alamat sistem
            const filteredHolders = topHolders.filter((h) => {
                const known = knownAccounts[h.address] || knownAccounts[h.owner];
                const isExcludedType = known && (known.type === 'AMM' || known.type === 'LOCKER');
                const isSystemAccount = h.owner === '1111111111111111111111111111111';
                return !isExcludedType && !isSystemAccount;
            });
            const markets = response.data.markets || [];
            const risks = response.data.risks || [];
            const rugCheckData = this.toRugCheckResponse(
                response.data,
                filteredHolders,
                markets,
                risks,
            );
            if (!this.checkHolderConcentration(rugCheckData)) {
                return {
                    passed: false,
                    reason:
                        rugCheckData.score > 1000
                            ? 'high_risk_score'
                            : rugCheckData.dangerReasons?.length
                              ? 'danger_risks_detected'
                              : 'high_concentration',
                    safetyIndex: 1 - rugCheckData.meta.topHoldersPercentage / 100,
                    permanent: true,
                    isCTO: false,
                };
            }

            // 🧑‍💻 CREATOR BALANCE CHECK (Anti-Dump)
            const creator = response.data.creator;
            let ownership: CreatorOwnershipResult = {
                creatorPct: null,
                isCTO: false,
                reliable: true,
            };
            if (creator) {
                // Gunakan RPC langsung alih-alih data topHolders RugCheck yang tidak lengkap
                ownership = await this.getCreatorOwnership(creator, tokenMint);
                if (!ownership.reliable) {
                    return {
                        passed: false,
                        reason: 'creator_data_unavailable',
                        permanent: false,
                        isCTO: false,
                    };
                }
            }
            const creatorPct = ownership.creatorPct ?? 0;
            const isCTO = creator ? ownership.isCTO : false;

            // Hitung safetyIndex menggunakan persentase (pct) langsung dari API
            const top10SumPct = filteredHolders
                .slice(0, 10)
                .reduce((sum: number, h: RugCheckApiHolder) => sum + (h.pct || 0), 0);
            const safetyIndex = 1 - top10SumPct / 100;

            const defaultSafetyIndex = isCTO ? '0.20' : '0.65';
            const minSafetyIndex = Number.parseFloat(
                this.configService.get<string>('RUGCHECK_MIN_SAFETY_INDEX', defaultSafetyIndex),
            );
            if (safetyIndex < minSafetyIndex) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 High Concentration: Top 10 pegang ${(1 - safetyIndex) * 100}%. Skip. (isCTO: ${isCTO})`,
                );
                return {
                    passed: false,
                    reason: 'high_concentration',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            // 🔥 LP Safety Check: Accept burned OR locked (PumpFun uses locked mechanism)
            const isPumpFunToken = tokenMint.toLowerCase().endsWith('pump');
            const lpSafe = markets.some(
                (m: RugCheckMarket) =>
                    m.lpType === 'burned' ||
                    m.lpStatus === 'burned' ||
                    m.lpType === 'locked' ||
                    m.lpStatus === 'locked',
            );
            // PumpFun tokens tanpa market data di RugCheck = normal (LP di bonding curve)
            if (!lpSafe && markets.length > 0 && !isPumpFunToken) {
                this.logger.warn(`[${tokenMint}] 🛑 LP NOT BURNED/LOCKED. Skip.`);
                return {
                    passed: false,
                    reason: 'lp_not_burned',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            const score = response.data.score || 0;
            if (score > 1000) {
                // Lebih ketat (1000) untuk meminimalkan kerugian
                this.logger.warn(`[${tokenMint}] 🛑 High Risk Score: ${score}. Skip.`);
                return {
                    passed: false,
                    reason: 'high_risk_score',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            // ⛔ HONEYPOT & PERMISSIONS CHECK
            const hasHoneypotRisk = risks.some(
                (r) =>
                    r.name.toLowerCase().includes('honeypot') ||
                    r.name.toLowerCase().includes('freeze') ||
                    r.name.toLowerCase().includes('mint authority'),
            );

            if (hasHoneypotRisk) {
                this.logger.warn(`[${tokenMint}] 🛑 HONEYPOT/FREEZE RISK detected. Skip.`);
                return {
                    passed: false,
                    reason: 'honeypot_detected',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            const highRisks = risks.filter((risk) => risk.level === 'danger');
            if (highRisks.length > 0) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 Danger risk detected (${highRisks.map((r) => r.name).join(', ')}). Skip.`,
                );
                return {
                    passed: false,
                    reason: 'danger_risks_detected',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            if (creator && !isCTO) {
                if (creatorPct > 5) {
                    this.logger.warn(
                        `[${tokenMint}] 🛑 Creator holds too much (${creatorPct.toFixed(2)}%). Skip.`,
                    );
                    return {
                        passed: false,
                        reason: 'creator_holds_too_much',
                        safetyIndex,
                        permanent: true,
                        isCTO,
                    };
                }
            }

            return {
                passed: true,
                creator: response.data.creator,
                topHolder: topHolders[0]?.address,
                safetyIndex,
                rugcheckScore: score,
                dangerRisksCount: highRisks.length,
                creatorHoldPct: creatorPct,
                top10HolderPct: top10SumPct,
                isCTO,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`RugCheck API Error: ${msg}`);
            return { passed: false, reason: 'rugcheck_error', permanent: false };
        }
    }

    private async getCreatorOwnership(
        creatorAddress: string,
        tokenMint: string,
    ): Promise<CreatorOwnershipResult> {
        try {
            const { PublicKey } = await import('@solana/web3.js');
            const creatorKey = new PublicKey(creatorAddress);
            const mintKey = new PublicKey(tokenMint);

            const creatorBalance = await this.getCreatorTokenBalanceWithRetry(creatorKey, mintKey);
            if (creatorBalance === null) {
                this.creatorRpcFailureCount++;
                this.logger.warn(
                    `[metrics] creator_rpc_failure=${this.creatorRpcFailureCount} token=${tokenMint}`,
                );
                return { creatorPct: null, isCTO: false, reliable: false };
            }

            const accountInfo = await this.connection.getAccountInfo(mintKey);
            if (!accountInfo) {
                this.creatorRpcFailureCount++;
                this.logger.warn(
                    `[metrics] creator_rpc_failure=${this.creatorRpcFailureCount} token=${tokenMint}`,
                );
                return { creatorPct: null, isCTO: false, reliable: false };
            }
            const { getMint } = await import('@solana/spl-token');
            const mintInfo = await getMint(this.connection, mintKey, undefined, accountInfo.owner);
            const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);

            if (totalSupply <= 0) {
                return { creatorPct: null, isCTO: false, reliable: false };
            }
            const creatorPct = (creatorBalance / totalSupply) * 100;
            return { creatorPct, isCTO: creatorPct < 0.1, reliable: true };
        } catch (error) {
            this.logger.error(
                `Failed to get creator ownership: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.creatorRpcFailureCount++;
            this.logger.warn(
                `[metrics] creator_rpc_failure=${this.creatorRpcFailureCount} token=${tokenMint}`,
            );
            return { creatorPct: null, isCTO: false, reliable: false };
        }
    }

    private async getCreatorTokenBalanceWithRetry(
        creatorKey: PublicKey,
        mintKey: PublicKey,
    ): Promise<number | null> {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const accounts = await this.connection.getParsedTokenAccountsByOwner(creatorKey, {
                    mint: mintKey,
                });
                if (accounts.value.length === 0) return 0;
                return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.warn(`Creator balance RPC failed (attempt ${attempt}/3): ${msg}`);
                if (attempt < 3) {
                    await new Promise((res) => setTimeout(res, 300 * attempt));
                }
            }
        }
        return null;
    }
}
