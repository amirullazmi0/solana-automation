import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import axios from 'axios';
import * as https from 'https';

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
    priceChange?: { h1?: number };
    volume?: { m5?: number, h1?: number };
    txns?: { 
        m5?: { buys?: number, sells?: number },
        h1?: { buys?: number, sells?: number }
    };
    info?: {
        socials?: SocialLink[];
        websites?: Website[];
    };
    baseToken?: { symbol?: string };
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
    private readonly ipCache: Record<string, string> = {
        'api.jup.ag': '18.239.105.107',
        'api.rugcheck.xyz': '104.26.0.126',
        'api.dexscreener.com': '104.26.8.188',
    };

    constructor(private readonly configService: ConfigService) {
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

            // 2. RPC CHECK (Security)
            const isSafetyPassed = await this.checkTokenSecurityRPC(tokenMint);
            if (!isSafetyPassed) {
                this.logger.warn(`[${tokenMint}] 🛑 Safety RPC check FAILED (Freeze/Mint authority). Skip.`);
                return { safe: false, reason: 'safety_rpc_failed', permanent: true, metadata: baseMetadata };
            }

            // 3. RUGCHECK (Advanced Safety Index & LP Burn)
            const rugResult = await this.checkRugCheckAPI(tokenMint);
            if (!rugResult.passed) {
                this.logger.warn(`[${tokenMint}] 🛑 RugCheck FAILED: ${rugResult.reason}. Skip.`);
                return { safe: false, reason: rugResult.reason || 'rugcheck_failed', metadata: baseMetadata };
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
            const response = await axios.get(`https://api.jup.ag/price/v2?ids=${tokenMint}`, {
                timeout: 3000,
                headers: { 'x-api-key': this.jupiterApiKey }
            });
            return parseFloat(response.data?.data?.[tokenMint]?.price) || null;
        } catch {
            return null;
        }
    }

    private async checkTokenSecurityRPC(tokenMint: string): Promise<boolean> {
        const mintPublicKey = new PublicKey(tokenMint);
        try {
            const mintInfo = await getMint(this.connection, mintPublicKey);
            return mintInfo.mintAuthority === null && mintInfo.freezeAuthority === null;
        } catch (e) {
            if (e instanceof Error) {
                this.logger.error(`[${tokenMint}] Mint authority check failed: ${e.message}`);
            }
            return false;
        }
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
            const minLiq = Number.parseFloat(this.configService.get<string>('MIN_LIQUIDITY_USD', '30000'));
            const minVol = Number.parseFloat(this.configService.get<string>('MIN_VOLUME_USD', '1000'));
            const minBuys = Number.parseInt(this.configService.get<string>('MIN_BUY_COUNT', '20'));
            const minVelocity = Number.parseFloat(this.configService.get<string>('MIN_VOLUME_MCAP_RATIO', '0.05'));
            const minMCap = Number.parseFloat(this.configService.get<string>('MIN_MCAP', '20000'));
            const maxMCap = Number.parseFloat(this.configService.get<string>('MAX_MCAP', '300000'));
            const minAge = Number.parseFloat(this.configService.get<string>('MIN_AGE_HOURS', '1'));
            const minConfidence = Number.parseFloat(this.configService.get<string>('MIN_BUY_CONFIDENCE', '0.7'));

            const response = await axios.get<{ pairs: DexScreenerPair[] }>(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                { timeout: 5000 },
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
                return { passed: false, reason: 'honeypot', liquidity, marketCap, symbol, pairCreatedAt, socials, volScore, zScore, priceChange1h: pair.priceChange?.h1 || 0, isPumpFun: pair.info?.websites?.some(w => w.url.includes('pump.fun')) || false };
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
            
            if (ageHours < minAge || ageHours > maxAge) {
                const isTooOld = ageHours > maxAge;
                return { 
                    passed: false, 
                    reason: isTooOld ? 'too_old' : 'too_young', 
                    permanent: isTooOld, 
                    marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun
                };
            }

            const volumeSurge = volume5m / (avgVol5m || 1);
            const minSurge = Number.parseFloat(this.configService.get<string>('ANALYZER_MIN_VOLUME_SURGE', '1.5'));
            if (volumeSurge < minSurge) {
                return { passed: false, reason: 'low_surge', volumeSurge, marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun };
            }
            if (priceChange1h < -15) {
                return { passed: false, reason: 'bearish_trend', marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun };
            }

            // 📊 BUY VS SELL RATIO (Confidence Score)
            if (confidenceScore < minConfidence) {
                return { passed: false, reason: 'low_buy_confidence', marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun };
            }

            if (liquidity < minLiq || volume5m < minVol || buys5m < minBuys) {
                return { passed: false, reason: 'low_metrics', marketCap, symbol, pairCreatedAt, socials, liquidity, volScore, zScore, priceChange1h, isPumpFun };
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
            if (ip && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) return ip;
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
        });
    }

    private async checkRugCheckAPI(tokenMint: string): Promise<{ 
        passed: boolean; 
        creator?: string; 
        topHolder?: string; 
        reason?: string;
        safetyIndex?: number;
    }> {
        try {
            const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, {
                timeout: 5000,
                httpsAgent: this.getHttpsAgent()
            });

            if (!response.data) return { passed: false, reason: 'rugcheck_no_data' };

            // 🛡️ SAFETY & HOLDER INDEX (Anti-Rug)
            // Rumus: Safety Index = 1 - (Total Supply Top 10 / Total Supply)
            const topHolders = (response.data.topHolders as RugCheckHolder[]) || [];
            const totalSupply = response.data.totalSupply || 1;
            const top10Sum = topHolders.slice(0, 10).reduce((sum: number, h: RugCheckHolder) => sum + (h.amount || 0), 0);
            const safetyIndex = 1 - (top10Sum / totalSupply);

            if (safetyIndex < 0.7) { // Berarti Top 10 pegang > 30%
                this.logger.warn(`[${tokenMint}] 🛑 High Concentration: Top 10 pegang ${(1 - safetyIndex) * 100}%. Skip.`);
                return { passed: false, reason: 'high_concentration', safetyIndex };
            }

            // 🔥 MANDATORY: Liquidity Burned Check
            const markets = (response.data.markets as RugCheckMarket[]) || [];
            const lpBurned = markets.some((m: RugCheckMarket) => m.lpType === 'burned' || m.lpStatus === 'burned');
            if (!lpBurned) {
                this.logger.warn(`[${tokenMint}] 🛑 LP NOT BURNED. Skip.`);
                return { passed: false, reason: 'lp_not_burned', safetyIndex };
            }

            const score = response.data.score || 0;
            if (score > 2000) { // Lebih ketat dari sebelumnya (3000)
                this.logger.warn(`[${tokenMint}] 🛑 High Risk Score: ${score}. Skip.`);
                return { passed: false, reason: 'high_risk_score', safetyIndex };
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
                return { passed: false, reason: 'honeypot_detected', safetyIndex };
            }

            const highRisks = risks.filter((risk) => risk.level === 'danger');
            if (highRisks.length > 0) {
                return { passed: false, reason: 'danger_risks_detected', safetyIndex };
            }

            // 🧑‍💻 CREATOR BALANCE CHECK (Anti-Dump)
            const creator = response.data.creator;
            if (creator) {
                const creatorHolder = topHolders.find(h => h.address === creator);
                const creatorPct = creatorHolder ? (creatorHolder.amount / totalSupply) * 100 : 0;
                if (creatorPct > 5) {
                    this.logger.warn(`[${tokenMint}] 🛑 Creator holds too much (${creatorPct.toFixed(2)}%). Skip.`);
                    return { passed: false, reason: 'creator_holds_too_much', safetyIndex };
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
            return { passed: false, reason: 'rugcheck_error' };
        }
    }
}
