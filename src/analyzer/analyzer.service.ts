import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import axios from 'axios';
import * as https from 'https';

export interface TokenMetadata {
    liquidity: number;
    marketCap: number;
    socials?: {
        twitter?: string;
        telegram?: string;
        website?: string;
    };
}

@Injectable()
export class AnalyzerService {
    private readonly logger = new Logger(AnalyzerService.name);
    private readonly connection: Connection;
    private readonly jupiterApiKey: string;
    private ipCache: Record<string, string> = {
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
     * Safety filter to check if token is safe to buy.
     */
    /**
     * Safety filter to check if token is safe and trending.
     */
    async isTokenSafeToBuy(tokenMint: string): Promise<{ safe: boolean; metadata?: TokenMetadata }> {
        try {
            // 1. CEK TRACTION DULU (DexScreener - REST API)
            // Ini menghemat jatah RPC karena kita cuma lanjut kalau koinnya beneran rame.
            const traction = await this.checkMarketTraction(tokenMint);
            if (!traction.passed) return { safe: false };

            this.logger.log(`[${tokenMint}] 🔥 Traction detected (Velocity: ${traction.velocity?.toFixed(2)}). Checking safety...`);

            // 2. CEK AUTHORITY (Solana RPC)
            const mintPublicKey = new PublicKey(tokenMint);
            let mintInfo;
            
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    mintInfo = await getMint(this.connection, mintPublicKey);
                    break;
                } catch (e) {
                    const isRateLimit = e.message?.includes('429');
                    const delay = isRateLimit ? 2000 * attempt : 500 * attempt;
                    
                    if (isRateLimit) this.logger.warn(`[${tokenMint}] RPC Rate Limit! Waiting ${delay}ms...`);
                    if (attempt === 3) return { safe: false };
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }

            if (mintInfo.mintAuthority !== null || mintInfo.freezeAuthority !== null) {
                this.logger.warn(`[${tokenMint}] Authority still enabled. Skip.`);
                return { safe: false };
            }

            // 3. RUGCHECK (REST API)
            const isRugCheckPassed = await this.checkRugCheckAPI(tokenMint);
            if (!isRugCheckPassed) return { safe: false };

            this.logger.log(`[${tokenMint}] ✅ Passed all filters. Ready to buy!`);
            return { 
                safe: true, 
                metadata: { 
                    liquidity: (traction as any).liquidity || 0, 
                    marketCap: (traction as any).marketCap || 0,
                    socials: (traction as any).socials
                } 
            } as any;
        } catch (error) {
            this.logger.error(`[${tokenMint}] Analysis failed: ${error.message}`);
            return { safe: false };
        }
    }

    private async checkMarketTraction(tokenMint: string): Promise<{ passed: boolean; liquidity?: number; marketCap?: number; velocity?: number; socials?: any }> {
        try {
            const minLiq = Number.parseFloat(this.configService.get<string>('MIN_LIQUIDITY_USD', '5000'));
            const minVol = Number.parseFloat(this.configService.get<string>('MIN_VOLUME_USD', '2000'));
            const minBuys = Number.parseInt(this.configService.get<string>('MIN_BUY_COUNT', '15'));
            const minVLR = Number.parseFloat(this.configService.get<string>('MIN_VL_RATIO', '2.0'));
            const minVelocity = Number.parseFloat(this.configService.get<string>('MIN_VOLUME_MCAP_RATIO', '0.1'));

            this.logger.log(`[${tokenMint}] Checking market traction via DexScreener...`);
            const response = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                { timeout: 5000, httpsAgent: this.getHttpsAgent() },
            );

            const pair = response.data.pairs?.[0];
            if (!pair) return { passed: false };

            const liquidity = pair.liquidity?.usd || 0;
            const volume5m = pair.volume?.m5 || 0;
            const buys5m = pair.txns?.m5?.buys || 0;
            const marketCap = pair.fdv || 0;
            
            const vlRatio = volume5m / (liquidity || 1);
            const velocity = volume5m / (marketCap || 1); // Volume 5m / Market Cap

            if (liquidity < minLiq || volume5m < minVol || vlRatio < minVLR || buys5m < minBuys) {
                return { passed: false };
            }

            // Velocity Check: Cari koin yang volume-nya meledak dibanding Market Cap
            if (velocity < minVelocity) {
                this.logger.warn(`[${tokenMint}] Low Velocity: ${velocity.toFixed(3)} (Min ${minVelocity}). Not hot enough.`);
                return { passed: false };
            }

            return { 
                passed: true, 
                liquidity, 
                marketCap,
                velocity,
                socials: {
                    twitter: pair.info?.socials?.find((s: any) => s.type === 'twitter')?.url,
                    telegram: pair.info?.socials?.find((s: any) => s.type === 'telegram')?.url,
                    website: pair.info?.websites?.[0]?.url
                }
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

    private async checkRugCheckAPI(tokenMint: string): Promise<boolean> {
        try {
            const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`, { 
                timeout: 10000,
                httpsAgent: this.getHttpsAgent()
            });

            const risks = (response.data.risks as Array<{ level: string; name: string }>) || [];
            const highRisks = risks.filter((risk) => risk.level === 'danger');

            if (highRisks.length > 0) {
                this.logger.warn(`[${tokenMint}] RugCheck danger: ${highRisks.map((r) => r.name).join(', ')}`);
                return false;
            }
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] RugCheck API unreachable: ${message}. Safety skip.`);
            return false; // Fail-safe: Jangan beli kalau status koin tidak bisa diverifikasi
        }
    }
}
