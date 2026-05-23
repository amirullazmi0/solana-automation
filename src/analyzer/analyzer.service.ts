import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import axios from 'axios';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { DexLimiter } from '../common/dex-limiter';

export interface SocialLink {
    type: string;
    url: string;
}

export interface Website {
    label?: string;
    url: string;
}

export interface DexScreenerPair {
    liquidity?: { usd?: number };
    fdv?: number;
    pairCreatedAt?: number;
    priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
    volume?: { m5?: number; h1?: number; h24?: number };
    txns?: { 
        m5?: { buys?: number; sells?: number };
        h1?: { buys?: number; sells?: number };
    };
    info?: {
        socials?: SocialLink[];
        websites?: Website[];
    };
    baseToken?: { address?: string; symbol?: string; name?: string };
}

export interface TokenMetadata {
    liquidity: number;
    marketCap: number;
    mcap?: number;
    pairCreatedAt?: number;
    symbol?: string;
    volumeSurge?: number;
    volScore?: number;
    zScore?: number;
    priceChange1h?: number;
    isPumpFun?: boolean;
    socials?: {
        twitter?: string;
        telegram?: string;
        website?: string;
    };
    creator?: string;
    topHolder?: string;
}

interface RugCheckHolder {
    address: string;
    amount: number;
    pct: number;
    owner: string;
}

interface RugCheckKnownAccount {
    name: string;
    type: string;
}

interface RugCheckMarket {
    lpType: string;
    lpStatus: string;
}

@Injectable()
export class AnalyzerService {
    private readonly logger = new Logger(AnalyzerService.name);
    private readonly connection: Connection;
    private readonly jupiterApiKey: string;
    private readonly ipCache: Record<string, string> = {};

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
    ) {
        const rpcEndpoint = this.configService.get<string>('RPC_ENDPOINT') || 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(rpcEndpoint, 'confirmed');
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
    }

    /**
     * Safety filter to check if token is safe and trending.
     */
    async isTokenSafeToBuy(tokenMint: string): Promise<{ safe: boolean; metadata?: TokenMetadata; reason?: string; permanent?: boolean }> {
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
                isPumpFun: traction.isPumpFun
            };

            if (!traction.passed) {
                return { 
                    safe: false, 
                    reason: traction.reason || 'low_traction', 
                    permanent: traction.permanent,
                    metadata: baseMetadata 
                };
            }

            // 🛡️ ADVANCED METRICS CHECK
            // 1. VoL Check (Min 0.05 untuk koin breakout)
            const minVolScore = Number.parseFloat(this.configService.get<string>('ANALYZER_MIN_VOL_SCORE', '0.05'));
            if (traction.volScore && traction.volScore < minVolScore) {
                this.logger.debug(`[${tokenMint}] Low VoL Score: ${traction.volScore.toFixed(4)}. Supply not shocked enough.`);
                return { safe: false, reason: 'low_vol_score', metadata: baseMetadata };
            }

            // 2. Z-Score Anomaly Check (Z > 2.5 is anomaly)
            const minZScore = Number.parseFloat(this.configService.get<string>('ANALYZER_MIN_Z_SCORE', '2.5'));
            if (traction.zScore && traction.zScore < minZScore) {
                this.logger.debug(`[${tokenMint}] Normal Volume (Z-Score: ${traction.zScore.toFixed(2)}). Waiting for anomaly...`);
                return { safe: false, reason: 'no_volume_anomaly', metadata: baseMetadata };
            }

            // 2. RPC CHECK (Security) — With PumpFun tolerance
            const isPumpFunToken = tokenMint.toLowerCase().endsWith('pump');
            const safetyRpc = await this.checkTokenSecurityRPC(tokenMint, isPumpFunToken);
            if (!safetyRpc.passed) {
                this.logger.warn(`[${tokenMint}] 🛑 Safety RPC check FAILED (Freeze/Mint authority). Skip.`);
                return { safe: false, reason: 'safety_rpc_failed', permanent: safetyRpc.permanent, metadata: baseMetadata };
            }

            // 3. RUGCHECK (Advanced Safety Index & LP Burn)
            const rugResult = await this.checkRugCheckAPI(tokenMint);
            if (!rugResult.passed) {
                this.logger.warn(`[${tokenMint}] 🛑 RugCheck FAILED: ${rugResult.reason}. Skip.`);
                return { safe: false, reason: rugResult.reason || 'rugcheck_failed', permanent: rugResult.permanent, metadata: baseMetadata };
            }

            // 🧑‍💻 DEV BLACKLIST CHECK (Anti-Rug)
            if (rugResult.creator) {
                const isBlacklisted = await this.prismaService.developerBlacklist.findUnique({
                    where: { address: rugResult.creator }
                });
                if (isBlacklisted) {
                    this.logger.warn(`[${tokenMint}] 🛑 Creator ${rugResult.creator} is blacklisted (Previous dump/rug). Skip.`);
                    return { safe: false, reason: 'creator_blacklisted', permanent: true, metadata: baseMetadata };
                }
            }

            this.logger.log(`[${tokenMint}] ✅ Passed Advanced Filters (VoL: ${traction.volScore?.toFixed(3)}, Z: ${traction.zScore?.toFixed(1)}, Safety: ${rugResult.safetyIndex?.toFixed(2)}). Ready!`);
            return { 
                safe: true, 
                metadata: { 
                    ...baseMetadata,
                    creator: rugResult.creator,
                    topHolder: rugResult.topHolder
                } 
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
            volumeSurge: traction.volumeSurge
        };
    }

    private async getJupiterPrice(tokenMint: string): Promise<number | null> {
        try {
            const response = await axios.get(`https://api.jup.ag/price/v3?ids=${tokenMint}`, {
                timeout: 3000,
                headers: { 'x-api-key': this.jupiterApiKey },
                httpsAgent: this.getHttpsAgent()
            });
            const data = response.data as Record<string, { usdPrice?: number } | undefined> | null;
            return data?.[tokenMint]?.usdPrice || null;
        } catch {
            return null;
        }
    }

    private async checkTokenSecurityRPC(tokenMint: string, isPumpFun = false): Promise<{ passed: boolean; permanent: boolean }> {
        const mintPublicKey = new PublicKey(tokenMint);
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const accountInfo = await this.connection.getAccountInfo(mintPublicKey);
                if (!accountInfo) {
                    throw new Error('Mint account not found on-chain');
                }
                const mintInfo = await getMint(this.connection, mintPublicKey, undefined, accountInfo.owner);

                // Mint authority HARUS null (tidak boleh cetak token baru)
                if (mintInfo.mintAuthority !== null) {
                    this.logger.warn(`[${tokenMint}] Mint authority still active. Reject.`);
                    return { passed: false, permanent: true };
                }

                // Freeze authority: PumpFun tokens sering punya freeze auth sementara post-migration
                if (mintInfo.freezeAuthority !== null) {
                    if (isPumpFun) {
                        this.logger.debug(`[${tokenMint}] ⚠️ Freeze authority active but PumpFun token — TOLERATED.`);
                        return { passed: true, permanent: false }; // PumpFun tolerance
                    }
                    this.logger.warn(`[${tokenMint}] Freeze authority active (non-PumpFun). Reject.`);
                    return { passed: false, permanent: true };
                }

                return { passed: true, permanent: false }; // Both null = safe
            } catch (e) {
                const errName = e instanceof Error ? (e.name || e.message) : String(e);
                this.logger.warn(`[${tokenMint}] Mint authority check failed (attempt ${attempt}/${maxRetries}): ${errName}`);
                if (attempt < maxRetries) {
                    await new Promise(res => setTimeout(res, 1000 * attempt));
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
    }> {
        try {
            const minLiq = Number.parseFloat(this.configService.get<string>('MIN_LIQUIDITY_USD', '3000'));
            const minVol = Number.parseFloat(this.configService.get<string>('MIN_VOLUME_USD', '200'));
            const minBuys = Number.parseInt(this.configService.get<string>('MIN_BUY_COUNT', '3'));
            const minVelocity = Number.parseFloat(this.configService.get<string>('MIN_VOLUME_MCAP_RATIO', '0.02'));
            const minMCap = Number.parseFloat(this.configService.get<string>('MIN_MCAP', '5000'));
            const maxMCap = Number.parseFloat(this.configService.get<string>('MAX_MCAP', '300000'));
            const minAge = Number.parseFloat(this.configService.get<string>('MIN_AGE_HOURS', '0.02'));
            const minConfidence = Number.parseFloat(this.configService.get<string>('MIN_BUY_CONFIDENCE', '0.50'));

            const response = await DexLimiter.get<{ pairs: DexScreenerPair[] }>(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                { 
                    timeout: 5000,
                    httpsAgent: this.getHttpsAgent()
                },
            );

            const pair = response.data.pairs?.[0];
            if (!pair) return { passed: false };

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
                website: pair.info?.websites?.[0]?.url
            };

            // 🛡️ HARD REJECT: Token tanpa liquidity = impossible to sell tanpa massive slippage
            if (!liquidity || liquidity < 1000) {
                const isYoung = (Date.now() - (pair.pairCreatedAt || 0)) < 1000 * 60 * 60; // < 1 hour
                return { 
                    passed: false, 
                    reason: 'zero_liquidity', 
                    permanent: !isYoung, // Hanya permanent kalau koin sudah lama tapi likuiditas tetep 0
                    liquidity, marketCap, symbol, pairCreatedAt, socials 
                };
            }

            // 🚀 EARLY REJECT: Cek filter murah dulu sebelum kalkulasi mahal
            if (liquidity < minLiq) {
                return { passed: false, reason: 'low_metrics', liquidity, marketCap, symbol, pairCreatedAt, socials };
            }
            if (volume5m < minVol) {
                return { passed: false, reason: 'low_metrics', liquidity, marketCap, symbol, pairCreatedAt, socials };
            }
            if (buys5m < minBuys) {
                return { passed: false, reason: 'low_metrics', liquidity, marketCap, symbol, pairCreatedAt, socials };
            }

            // 1. VoL (Velocity of Liquidity)
            // Rumus: (Volume 5m / Liquidity) * Confidence Score
            const confidenceScore = (buys5m / (buys5m + sells5m || 1));
            const volScore = (volume5m / (liquidity || 1)) * confidenceScore;

            // 2. Volume Z-Score (Anomaly Detection)
            // Pseudo Z-Score: (Current - Avg) / StdDev (Asumsi StdDev = Avg * 0.5)
            const avgVol5m = volumeH1 / 12;
            const zScore = (volume5m - avgVol5m) / (avgVol5m * 0.5 || 1);

            // 🚫 HONEYPOT DETECTION
            if (buys5m >= 10 && sells5m === 0) {
                return { passed: false, reason: 'honeypot', permanent: true, liquidity, marketCap, symbol, pairCreatedAt, socials, volScore, zScore, priceChange1h: pair.priceChange?.h1 || 0, isPumpFun: pair.info?.websites?.some(w => w.url.includes('pump.fun')) || false };
            }
            
            const velocity = volume5m / (marketCap || 1);
            const isPumpFun = pair.info?.websites?.some(w => w.url.includes('pump.fun')) || false;
            const priceChange1h = pair.priceChange?.h1 || 0;
            
            if (marketCap < minMCap || marketCap > maxMCap) {
                const isPerm = marketCap > maxMCap; // MCap kegedean baru permanent
                return { passed: false, reason: marketCap > maxMCap ? 'mcap_too_high' : 'mcap_too_low', permanent: isPerm, marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun };
            }

            const ageHours = (Date.now() - (pair.pairCreatedAt || 0)) / (1000 * 60 * 60);
            const maxAge = Number.parseFloat(this.configService.get<string>('MAX_AGE_HOURS', '24.0'));
            const establishedMaxAge = Number.parseFloat(this.configService.get<string>('ESTABLISHED_MAX_AGE_HOURS', '72.0'));
            const absoluteMaxAge = Math.max(maxAge, establishedMaxAge);
            
            if (ageHours < minAge || ageHours > maxAge) {
                const isTooOld = ageHours > maxAge;
                const isPerm = isTooOld && (ageHours > absoluteMaxAge);
                return { 
                    passed: false, 
                    reason: isTooOld ? 'too_old' : 'too_young', 
                    permanent: isPerm, 
                    marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun
                };
            }

            const volumeSurge = volume5m / (avgVol5m || 1);
            const minSurge = Number.parseFloat(this.configService.get<string>('ANALYZER_MIN_VOLUME_SURGE', '1.5'));
            if (volumeSurge < minSurge) {
                return { passed: false, reason: 'low_surge', volumeSurge, marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun };
            }
            if (priceChange1h < -15) {
                return { passed: false, reason: 'bearish_trend', permanent: true, marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun };
            }

            // 📊 BUY VS SELL RATIO (Confidence Score)
            if (confidenceScore < minConfidence) {
                return { passed: false, reason: 'low_buy_confidence', marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun };
            }

            if (velocity < minVelocity) {
                return { passed: false, reason: 'low_velocity', marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun };
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
                isPumpFun
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
            let response = await axios.get(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
                headers: { accept: 'application/dns-json' },
                timeout: 5000,
                httpsAgent: new https.Agent({ family: 4 }),
            }).catch(() => null);

            if (!response) {
                response = await axios.get(`https://8.8.8.8/resolve?name=${hostname}&type=A`, {
                    timeout: 5000,
                    httpsAgent: new https.Agent({ family: 4 }),
                }).catch(() => null);
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
                        import('dns').then(({ lookup }) => {
                            lookup(hostname, options, cb);
                        }).catch((err) => {
                            cb(err, '', 4);
                        });
                    }
                } catch (e) {
                    cb(e as Error, '', 4);
                }
            }
        });
    }

    private async checkRugCheckAPI(tokenMint: string): Promise<{ 
        passed: boolean; 
        creator?: string; 
        topHolder?: string; 
        reason?: string;
        safetyIndex?: number;
        permanent?: boolean;
    }> {
        try {
            const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, {
                timeout: 5000,
                httpsAgent: this.getHttpsAgent()
            });

            if (!response.data) return { passed: false, reason: 'rugcheck_no_data', permanent: false };

            const topHolders = (response.data.topHolders as RugCheckHolder[]) || [];
            const knownAccounts = (response.data.knownAccounts as Record<string, RugCheckKnownAccount | undefined>) || {};

            // 🛡️ SAFETY & HOLDER INDEX (Anti-Rug) - Saring dompet AMM, lockers, dan alamat sistem
            const filteredHolders = topHolders.filter(h => {
                const known = knownAccounts[h.address] || knownAccounts[h.owner];
                const isExcludedType = known && (known.type === 'AMM' || known.type === 'LOCKER');
                const isSystemAccount = h.owner === '1111111111111111111111111111111';
                return !isExcludedType && !isSystemAccount;
            });

            // Hitung safetyIndex menggunakan persentase (pct) langsung dari API
            const top10SumPct = filteredHolders.slice(0, 10).reduce((sum: number, h: RugCheckHolder) => sum + (h.pct || 0), 0);
            const safetyIndex = 1 - (top10SumPct / 100);

            const minSafetyIndex = Number.parseFloat(this.configService.get<string>('RUGCHECK_MIN_SAFETY_INDEX', '0.65'));
            if (safetyIndex < minSafetyIndex) {
                this.logger.warn(`[${tokenMint}] 🛑 High Concentration: Top 10 pegang ${(1 - safetyIndex) * 100}%. Skip.`);
                return { passed: false, reason: 'high_concentration', safetyIndex, permanent: true };
            }

            // 🔥 LP Safety Check: Accept burned OR locked (PumpFun uses locked mechanism)
            const markets = (response.data.markets as RugCheckMarket[]) || [];
            const isPumpFunToken = tokenMint.toLowerCase().endsWith('pump');
            const lpSafe = markets.some((m: RugCheckMarket) => 
                m.lpType === 'burned' || m.lpStatus === 'burned' || 
                m.lpType === 'locked' || m.lpStatus === 'locked'
            );
            // PumpFun tokens tanpa market data di RugCheck = normal (LP di bonding curve)
            if (!lpSafe && markets.length > 0 && !isPumpFunToken) {
                this.logger.warn(`[${tokenMint}] 🛑 LP NOT BURNED/LOCKED. Skip.`);
                return { passed: false, reason: 'lp_not_burned', safetyIndex, permanent: true };
            }

            const score = response.data.score || 0;
            if (score > 2000) { // Lebih ketat dari sebelumnya (3000)
                this.logger.warn(`[${tokenMint}] 🛑 High Risk Score: ${score}. Skip.`);
                return { passed: false, reason: 'high_risk_score', safetyIndex, permanent: true };
            }

            // ⛔ HONEYPOT & PERMISSIONS CHECK
            const risks = (response.data.risks as Array<{ level: string; name: string }>) || [];
            const hasHoneypotRisk = risks.some(r => 
                r.name.toLowerCase().includes('honeypot') || 
                r.name.toLowerCase().includes('freeze') ||
                r.name.toLowerCase().includes('mint authority')
            );

            if (hasHoneypotRisk) {
                this.logger.warn(`[${tokenMint}] 🛑 HONEYPOT/FREEZE RISK detected. Skip.`);
                return { passed: false, reason: 'honeypot_detected', safetyIndex, permanent: true };
            }

            const highRisks = risks.filter((risk) => risk.level === 'danger');
            if (highRisks.length >= 2) {
                this.logger.warn(`[${tokenMint}] 🛑 Multiple danger risks detected (${highRisks.length}). Skip.`);
                return { passed: false, reason: 'danger_risks_detected', safetyIndex, permanent: true };
            }

            // 🧑‍💻 CREATOR BALANCE CHECK (Anti-Dump)
            const creator = response.data.creator;
            if (creator) {
                const creatorHolder = topHolders.find(h => h.address === creator || h.owner === creator);
                const creatorPct = creatorHolder ? creatorHolder.pct : 0;
                if (creatorPct > 5) {
                    this.logger.warn(`[${tokenMint}] 🛑 Creator holds too much (${creatorPct.toFixed(2)}%). Skip.`);
                    return { passed: false, reason: 'creator_holds_too_much', safetyIndex, permanent: true };
                }
            }

            return { 
                passed: true, 
                creator: response.data.creator, 
                topHolder: response.data.topHolders?.[0]?.address,
                safetyIndex
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`RugCheck API Error: ${msg}`);
            return { passed: false, reason: 'rugcheck_error', permanent: false };
        }
    }
}


