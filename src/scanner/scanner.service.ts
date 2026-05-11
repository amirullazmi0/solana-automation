import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection } from '@solana/web3.js';
import axios from 'axios';
import * as WebSocket from 'ws';
import { AnalyzerService } from '../analyzer/analyzer.service';
import { TradeService } from '../trade/trade.service';

// const RAYDIUM_PROGRAM_ID = new PublicKey('675kRwJGm1MqJCYR6ba8Lde6ygvwtq22U6cC1Fi991S8');

@Injectable()
export class ScannerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ScannerService.name);
    private connection: Connection;
    private subscriptionId: number;
    private pumpFunWs: WebSocket;
    private readonly seenTokens = new Set<string>();

    constructor(
        private readonly configService: ConfigService,
        private readonly tradeService: TradeService,
        private readonly analyzerService: AnalyzerService,
    ) {}

    onModuleInit() {
        const wssEndpoint = this.configService.get<string>('WSS_ENDPOINT');
        const rpcEndpoint = this.configService.get<string>('RPC_ENDPOINT');

        if (!wssEndpoint || !rpcEndpoint) {
            this.logger.error('RPC or WSS endpoints not configured. Scanner will not start.');
            return;
        }

        this.connection = new Connection(rpcEndpoint, {
            wsEndpoint: wssEndpoint,
            commitment: 'confirmed',
        });

        this.startDiscoveryPolling();
    }

    onModuleDestroy() {
        if (this.subscriptionId && this.connection) {
            this.connection.removeProgramAccountChangeListener(this.subscriptionId);
        }
        if (this.pumpFunWs) {
            this.pumpFunWs.close();
        }
        this.logger.log('Scanner stopped');
    }


    private startDiscoveryPolling() {
        this.logger.log('Starting Trend Discovery Polling (Boosted & Trending)...');
        
        // Poll every 30 seconds to find new trending candidates
        setInterval(async () => {
            try {
                // Gunakan Token Boosts API sebagai sumber koin yang 'niat' jualan (punya marketing budget)
                const response = await axios.get(
                    'https://api.dexscreener.com/token-boosts/latest/v1',
                    { timeout: 10000 },
                );

                const solTokens = (response.data as Array<{ chainId: string; tokenAddress: string }>)
                    .filter((t) => t.chainId === 'solana');

                for (const token of solTokens) {
                    const mint = token.tokenAddress;
                    
                    // Kita cek koin yang belum pernah kita beli/pantau baru-baru ini
                    if (!this.seenTokens.has(mint)) {
                        this.seenTokens.add(mint);
                        this.logger.log(`🔍 [Discovery] Potential Second-Wave Candidate: ${mint}`);
                        
                        // Jalankan analisa mendalam
                        this.processNewToken(mint);
                        
                        // Jeda agar tidak kena rate limit
                        await new Promise((res) => setTimeout(res, 2000));
                    }
                }
            } catch (error) {
                this.logger.debug(`Discovery Polling error: ${error.message}`);
            }
        }, 30000);
    }

    private async processNewToken(tokenMint: string) {
        this.logger.log(`[${tokenMint}] Starting monitoring for market traction (Max 10 minutes)...`);

        const startTime = Date.now();
        const maxWaitTime = 10 * 60 * 1000; // 10 Menit

        while (Date.now() - startTime < maxWaitTime) {
            try {
                const result = await this.analyzerService.isTokenSafeToBuy(tokenMint);
                
                if (result.safe) {
                    this.logger.log(`[${tokenMint}] 🚀 Traction detected! Attempting to buy...`);
                    await this.tradeService.attemptBuy(tokenMint, result.metadata);
                    return; // Selesai, sudah dibeli
                }

                // Log alasan spesifik kalau traction sudah dideteksi tapi safety gagal
                if (result.reason && result.reason !== 'low_traction') {
                    this.logger.warn(`[${tokenMint}] ⚠️ Safety failed (${result.reason}). Waiting 30s to re-check...`);
                } else {
                    this.logger.log(`[${tokenMint}] Still quiet... waiting 30s to re-check.`);
                }

                await new Promise((res) => setTimeout(res, 30000));
            } catch (error) {
                this.logger.error(`Error processing token ${tokenMint}: ${error.message}`);
                break;
            }
        }

        this.logger.log(`[${tokenMint}] 💤 Token remained quiet after 10 minutes. Giving up.`);
        
        // Hapus dari memory setelah 10 menit biar kalau nanti koin ini mendadak rame lagi, bot bisa nangkap lagi
        setTimeout(() => this.seenTokens.delete(tokenMint), 10 * 60 * 1000);
    }
}
