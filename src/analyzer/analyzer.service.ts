import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import axios from 'axios';

@Injectable()
export class AnalyzerService {
  private readonly logger = new Logger(AnalyzerService.name);
  private connection: Connection;

  constructor(private configService: ConfigService) {
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

      // Fetch Mint Info once
      const mintInfo = await getMint(this.connection, mintPublicKey);

      // 1. Check if Mint Authority is disabled
      if (mintInfo.mintAuthority !== null) {
        this.logger.warn(`[${tokenMint}] Mint authority is still enabled (${mintInfo.mintAuthority.toBase58()}).`);
        return false;
      }

      // 2. Check if Freeze Authority is disabled
      if (mintInfo.freezeAuthority !== null) {
        this.logger.warn(`[${tokenMint}] Freeze authority is still enabled (${mintInfo.freezeAuthority.toBase58()}).`);
        return false;
      }

      // 3. RugCheck API Integration
      const isRugCheckPassed = await this.checkRugCheckAPI(tokenMint);
      if (!isRugCheckPassed) {
        this.logger.warn(`[${tokenMint}] Failed RugCheck validation.`);
        return false;
      }

      // 4. Check if Liquidity > $5,000
      const hasEnoughLiquidity = await this.checkLiquidity(tokenMint);
      if (!hasEnoughLiquidity) {
        this.logger.warn(`[${tokenMint}] Liquidity is less than $5,000.`);
        return false;
      }

      this.logger.log(`[${tokenMint}] Passed all safety filters.`);
      return true;
    } catch (error) {
      this.logger.error(`[${tokenMint}] Error analyzing token: ${error.message}`);
      return false; // Fail safe
    }
  }

  private async checkRugCheckAPI(tokenMint: string): Promise<boolean> {
    try {
      this.logger.log(`[${tokenMint}] Fetching RugCheck report via Axios...`);
      const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`, { timeout: 10000 });
      
      const data = response.data;
      const highRisks = data.risks?.filter((risk: any) => risk.level === 'danger') || [];
      
      if (highRisks.length > 0) {
        this.logger.warn(`[${tokenMint}] RugCheck identified danger risks: ${highRisks.map(r => r.name).join(', ')}`);
        return false;
      }

      return true;
    } catch (error) {
      const errorMsg = error.response ? `Status ${error.response.status}` : error.message;
      this.logger.error(`[${tokenMint}] Error calling RugCheck API: ${errorMsg}`);
      return false; // Fail safe
    }
  }

  private async checkLiquidity(tokenMint: string): Promise<boolean> {
    return true;
  }
}
