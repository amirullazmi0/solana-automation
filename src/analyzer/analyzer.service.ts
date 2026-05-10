import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import axios from 'axios';

@Injectable()
export class AnalyzerService {
    private readonly logger = new Logger(AnalyzerService.name);
    private readonly connection: Connection;

    constructor(private readonly configService: ConfigService) {
        const rpcEndpoint = this.configService.get<string>('RPC_ENDPOINT');
        if (rpcEndpoint) {
            this.connection = new Connection(rpcEndpoint, 'confirmed');
        }
    }

    /**
     * Safety filter to check if token is safe to buy.
     */
    async isTokenSafeToBuy(tokenMint: string): Promise<boolean> {
        this.logger.log(`Analyzing token ${tokenMint}...`);

        try {
            const mintPublicKey = new PublicKey(tokenMint);

            // Fetch Mint Info with simple retry (Solana propagation delay)
            let mintInfo;
            for (let i = 0; i < 3; i++) {
                try {
                    mintInfo = await getMint(this.connection, mintPublicKey);
                    break;
                } catch (e) {
                    if (i === 2) {
                        this.logger.warn(`[${tokenMint}] Could not fetch mint info after 3 attempts: ${e.message}`);
                        return false;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1000));
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

            // 4. Check if Liquidity > $500
            const hasEnoughLiquidity = await this.checkLiquidity(tokenMint);
            if (!hasEnoughLiquidity) {
                return false;
            }

            this.logger.log(`[${tokenMint}] ✅ Passed all safety filters.`);
            return true;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] Error analyzing token: ${errorMsg}`);
            return false; // Fail safe
        }
    }

    private async checkRugCheckAPI(tokenMint: string): Promise<boolean> {
        try {
            this.logger.log(`[${tokenMint}] Fetching RugCheck report via Axios...`);
            const response = await axios.get(
                `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`,
                { timeout: 10000 },
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

    private async checkLiquidity(tokenMint: string): Promise<boolean> {
        try {
            this.logger.log(`[${tokenMint}] Checking liquidity via DexScreener...`);
            const response = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                { timeout: 5000 },
            );

            const pairs = response.data.pairs;
            if (!pairs || pairs.length === 0) {
                this.logger.log(`[${tokenMint}] Token not yet on DexScreener, skipping liquidity check to allow sniping.`);
                return true;
            }

            // Get liquidity in USD from the first pair
            const liquidity = pairs[0].liquidity?.usd || 0;
            if (liquidity < 500) {
                this.logger.warn(`[${tokenMint}] Low liquidity: $${liquidity.toFixed(2)} USD (Min $500)`);
                return false;
            }

            this.logger.log(`[${tokenMint}] Liquidity check passed: $${liquidity.toFixed(2)} USD`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] Liquidity check failed: ${message}`);
            // Fail open (return true) only if API is down, to avoid missing trades
            return true;
        }
    }
}
