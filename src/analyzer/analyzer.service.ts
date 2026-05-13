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
    socials?: {
        twitter?: string;
        telegram?: string;
        website?: string;
    };
    creator?: string;
    topHolder?: string;
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
            // 1. DEXSCREENER (Traction & Metadata - Faster for new tokens)
            const traction = await this.checkMarketTraction(tokenMint);
            
            const baseMetadata: TokenMetadata = {
                liquidity: traction.liquidity || 0,
                marketCap: traction.marketCap || 0,
                mcap: traction.marketCap,
                pairCreatedAt: traction.pairCreatedAt,
                symbol: traction.symbol,
                socials: traction.socials,
                volumeSurge: traction.volumeSurge
            };

            if (!traction.passed) {
                return { 
                    safe: false, 
                    reason: traction.reason || 'low_traction', 
                    permanent: traction.permanent,
                    metadata: baseMetadata 
                };
            }

            // 2. RPC CHECK (Security)
            const isSafetyPassed = await this.checkTokenSecurityRPC(tokenMint);
            if (!isSafetyPassed) {
                this.logger.warn(`[${tokenMint}] 🛑 Safety RPC check FAILED (Freeze/Mint authority). Skip.`);
                return { safe: false, reason: 'safety_rpc_failed', permanent: true, metadata: baseMetadata };
            }

            // 3. RUGCHECK (REST API)
            const isRugCheckPassed = await this.checkRugCheckAPI(tokenMint);
            if (!isRugCheckPassed) {
                this.logger.warn(`[${tokenMint}] 🛑 RugCheck FAILED or High Risk. Skip.`);
                return { safe: false, reason: 'rugcheck_failed', metadata: baseMetadata };
            }

            this.logger.log(`[${tokenMint}] ✅ Passed all filters. Ready to buy!`);
            return { 
                safe: true, 
                metadata: { 
                    ...baseMetadata,
                    creator: isRugCheckPassed.creator,
                    topHolder: isRugCheckPassed.topHolder
                } 
            };
        } catch (error) {
            this.logger.error(`[${tokenMint}] Analysis failed: ${error.message}`);
            return { safe: false, reason: 'error' };
        }
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
    }> {
        try {
            const minLiq = Number.parseFloat(this.configService.get<string>('MIN_LIQUIDITY_USD', '30000'));
            const minVol = Number.parseFloat(this.configService.get<string>('MIN_VOLUME_USD', '1000'));
            const minBuys = Number.parseInt(this.configService.get<string>('MIN_BUY_COUNT', '20'));
            const minVelocity = Number.parseFloat(this.configService.get<string>('MIN_VOLUME_MCAP_RATIO', '0.05'));
            const minMCap = Number.parseFloat(this.configService.get<string>('MIN_MCAP', '30000'));
            const maxMCap = Number.parseFloat(this.configService.get<string>('MAX_MCAP', '150000'));

            this.logger.log(`[${tokenMint}] Checking market traction via DexScreener...`);
            const response = await axios.get<{ pairs: DexScreenerPair[] }>(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                { timeout: 5000 },
            );

            const pair = response.data.pairs?.[0];
            if (!pair) return { passed: false };

            const liquidity = pair.liquidity?.usd || 0;
            const volume5m = pair.volume?.m5 || 0;
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

            // 🚫 HONEYPOT DETECTION
            if (buys5m >= 10 && sells5m === 0) {
                return { passed: false, reason: 'honeypot', liquidity, marketCap, symbol, pairCreatedAt, socials };
            }
            
            const velocity = volume5m / (marketCap || 1);
            
            // 📊 TREND FOLLOWER LOGIC: MCap Sweet Spot (Respect .env)
            if (marketCap < minMCap || marketCap > maxMCap) {
                return { passed: false, reason: marketCap > maxMCap ? 'mcap_too_high' : 'mcap_too_low', permanent: true, marketCap, symbol, pairCreatedAt, socials, liquidity };
            }

            // 🕒 AGE CHECK (Second Wave: 2-96 Hours)
            const ageHours = (Date.now() - (pair.pairCreatedAt || 0)) / (1000 * 60 * 60);
            if (ageHours < 2 || ageHours > 96) {
                const isPerm = ageHours > 96 || ageHours < 1;
                return { passed: false, reason: ageHours > 96 ? 'too_old' : 'too_young', permanent: isPerm, marketCap, symbol, pairCreatedAt, socials, liquidity };
            }

            // 🚀 VOLUME SURGE
            const volumeH1 = pair.volume?.h1 || 0;
            const volumeSurge = volume5m / (volumeH1 / 12 || 1);
            
            if (volumeSurge < 1.5) {
                this.logger.debug(`[${tokenMint}] Surge low: ${volumeSurge.toFixed(2)}x. Waiting for breakout...`);
                return { passed: false, reason: 'low_surge', volumeSurge, marketCap, symbol, pairCreatedAt, socials, liquidity };
            }

            // 🐋 SMART MONEY ACCUMULATION
            const priceChange1h = pair.priceChange?.h1 || 0;
            const buys1h = pair.txns?.h1?.buys || 0;
            const sells1h = pair.txns?.h1?.sells || 0;

            // 📈 BULLISH TREND CHECK: Jangan beli koin yang harganya lagi terjun bebas
            if (priceChange1h <= 0) {
                this.logger.warn(`[${tokenMint}] 📉 Price trend is bearish (${priceChange1h.toFixed(2)}%). Skip.`);
                return { passed: false, reason: 'bearish_trend', marketCap, symbol, pairCreatedAt, socials, liquidity };
            }

            const isAccumulating = Math.abs(priceChange1h) < 10 && buys1h > sells1h * 1.5;

            if (liquidity < minLiq || volume5m < minVol || buys5m < minBuys) {
                // Jika koin sedang akumulasi, kita kasih toleransi volume sedikit lebih rendah
                if (!isAccumulating) return { passed: false };
                this.logger.log(`[${tokenMint}] 🐋 Accumulation detected! Price flat (${priceChange1h.toFixed(1)}%), Buys > Sells. Proceeding...`);
            }

            // Velocity Check
            if (velocity < minVelocity) {
                this.logger.warn(`[${tokenMint}] Low Velocity: ${velocity.toFixed(3)} (Min ${minVelocity}).`);
                return { passed: false };
            }

            return { 
                passed: true, 
                liquidity, 
                marketCap, 
                velocity, 
                socials,
                symbol,
                pairCreatedAt,
                volumeSurge
            };
        } catch (error) {
            this.logger.error(`[${tokenMint}] Traction check failed: ${error.message}`);
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
            this.logger.error(`[${hostname}] DNS resolution failed: ${error.message}`);
        }
        return hostname;
    }

    private getHttpsAgent() {
        return new https.Agent({
            family: 4,
            lookup: async (h, o, cb) => {
                try {
                    const ip = await this.resolveDns(h);
                    cb(null, ip as string, 4);
                } catch (e) {
                    cb(e as Error, '', 4);
                }
            }
        });
    }

    private async checkRugCheckAPI(tokenMint: string): Promise<{ passed: boolean; creator?: string; topHolder?: string }> {
        try {
            // RugCheck API: Cek skor risiko dan daftar bahaya (danger)
            const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`, {
                timeout: 5000,
                httpsAgent: this.getHttpsAgent()
            });

            if (!response.data) return { passed: false };

            // 1. Cek Skor (Score > 3000 = Skip)
            const score = response.data.score || 0;
            if (score > 3000) {
                this.logger.warn(`[${tokenMint}] High Risk Score: ${score}. Skip.`);
                return { passed: false };
            }

            // 2. Cek Risiko Spesifik (Danger = Skip)
            const risks = (response.data.risks as Array<{ level: string; name: string }>) || [];
            const highRisks = risks.filter((risk) => risk.level === 'danger');
            if (highRisks.length > 0) {
                this.logger.warn(`[${tokenMint}] RugCheck DANGER: ${highRisks.map((r) => r.name).join(', ')}`);
                return { passed: false };
            }

            // 3. Ekstrak Alamat Dompet "Musuh"
            const creator = response.data.creator;
            const topHolder = response.data.topHolders?.[0]?.address;

            return { 
                passed: true, 
                creator, 
                topHolder 
            };
        } catch (error) {
            this.logger.error(`RugCheck API Error: ${error.message}`);
            return { passed: false };
        }
    }
}
