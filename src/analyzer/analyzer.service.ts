import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import axios from 'axios';
import * as https from 'https';

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
    async isTokenSafeToBuy(tokenMint: string): Promise<boolean> {
        this.logger.log(`Analyzing token ${tokenMint}...`);

        try {
            const mintPublicKey = new PublicKey(tokenMint);

            // Fetch Mint Info with simple retry (Solana propagation delay)
            let mintInfo;
            let lastError;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    mintInfo = await getMint(this.connection, mintPublicKey);
                    break;
                } catch (e) {
                    lastError = e;
                    const isRateLimit = e.message?.includes('429') || e.toString().includes('429');
                    const delay = isRateLimit ? 2000 * attempt : 500 * attempt;
                    
                    if (isRateLimit) {
                        this.logger.warn(`[${tokenMint}] RPC Rate limit hit. Backing off for ${delay}ms...`);
                    }

                    if (attempt === 3) {
                        this.logger.warn(`[${tokenMint}] Could not fetch mint info after 3 attempts: ${lastError.message}`);
                        return false;
                    }
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }

            // 1. Check if Mint Authority is disabled
            if (mintInfo.mintAuthority !== null) {
                this.logger.warn(
                    `[${tokenMint}] Mint authority is still enabled (${mintInfo.mintAuthority.toBase58()}).`,
                );
                return false;
            }

            // 2. Check if Freeze Authority is disabled
            if (mintInfo.freezeAuthority !== null) {
                this.logger.warn(
                    `[${tokenMint}] Freeze authority is still enabled (${mintInfo.freezeAuthority.toBase58()}).`,
                );
                return false;
            }

            // 3. RugCheck API Integration
            const isRugCheckPassed = await this.checkRugCheckAPI(tokenMint);
            if (!isRugCheckPassed) {
                return false;
            }

            // 4. Check if Token is TRENDING (Volume, Liquidity, Buys)
            const isTrending = await this.checkMarketTraction(tokenMint);
            if (!isTrending) {
                return false;
            }

            this.logger.log(`[${tokenMint}] ✅ Passed all safety & trending filters.`);
            return true;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] Error analyzing token: ${errorMsg}`);
            return false; // Fail safe
        }
    }

    private async resolveDns(hostname: string): Promise<string> {
        if (this.ipCache[hostname]) return this.ipCache[hostname];
        try {
            // Try Cloudflare first
            let response = await axios
                .get(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
                    headers: { accept: 'application/dns-json' },
                    timeout: 5000,
                    httpsAgent: new https.Agent({ family: 4 }),
                })
                .catch(() => null);

            // If Cloudflare fails, try Google
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
                return ip;
            }
        } catch {
            // Silence DNS errors
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
            this.logger.log(`[${tokenMint}] Fetching RugCheck report via Axios...`);
            const response = await axios.get(
                `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`,
                { 
                    timeout: 10000,
                    httpsAgent: this.getHttpsAgent()
                },
            );

            const data = response.data;
            const highRisks = (
                (data.risks as Array<{ level: string; name: string }>) || []
            ).filter((risk) => risk.level === 'danger');

            if (highRisks.length > 0) {
                this.logger.warn(
                    `[${tokenMint}] RugCheck identified danger risks: ${highRisks.map((r) => r.name).join(', ')}`,
                );
                return false;
            }

            return true;
        } catch (error) {
            const errorMsg = axios.isAxiosError(error)
                ? error.response
                    ? `Status ${error.response.status}`
                    : error.message
                : error instanceof Error
                  ? error.message
                  : String(error);
            this.logger.error(`[${tokenMint}] Error calling RugCheck API: ${errorMsg}`);
            return true;
        }
    }

    private async checkMarketTraction(tokenMint: string): Promise<boolean> {
        try {
            const minLiq = parseFloat(this.configService.get<string>('MIN_LIQUIDITY_USD', '5000'));
            const minVol = parseFloat(this.configService.get<string>('MIN_VOLUME_USD', '1000'));
            const minBuys = parseInt(this.configService.get<string>('MIN_BUY_COUNT', '10'));

            this.logger.log(`[${tokenMint}] Checking market traction via DexScreener...`);
            const response = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                { 
                    timeout: 5000, 
                    httpsAgent: this.getHttpsAgent()
                },
            );

            const pair = response.data.pairs?.[0];
            if (!pair) {
                this.logger.log(`[${tokenMint}] Token sepi / Belum terdaftar di DexScreener. Skipping.`);
                return false;
            }

            const liquidity = pair.liquidity?.usd || 0;
            const volume5m = pair.volume?.m5 || 0;
            const buys5m = pair.txns?.m5?.buys || 0;

            if (liquidity < minLiq) {
                this.logger.warn(`[${tokenMint}] Liquidity too low: $${liquidity.toFixed(0)} (Min $${minLiq})`);
                return false;
            }

            if (volume5m < minVol) {
                this.logger.warn(`[${tokenMint}] Volume (5m) too low: $${volume5m.toFixed(0)} (Min $${minVol})`);
                return false;
            }

            if (buys5m < minBuys) {
                this.logger.warn(`[${tokenMint}] Buys (5m) too low: ${buys5m} txs (Min ${minBuys})`);
                return false;
            }

            this.logger.log(`[${tokenMint}] 🔥 TRENDING! Liq: $${liquidity.toFixed(0)} | Vol5m: $${volume5m.toFixed(0)} | Buys5m: ${buys5m}`);
            return true;
        } catch (error) {
            this.logger.error(`[${tokenMint}] Traction check failed: ${error.message}`);
            return false;
        }
    }
}
