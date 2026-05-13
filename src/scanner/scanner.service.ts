import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection } from '@solana/web3.js';
import axios from 'axios';
import * as WebSocket from 'ws';
import { AnalyzerService } from '../analyzer/analyzer.service';
import { TradeService } from '../trade/trade.service';
import { ReportingService } from '../reporting/reporting.service';

// const RAYDIUM_PROGRAM_ID = new PublicKey('675kRwJGm1MqJCYR6ba8Lde6ygvwtq22U6cC1Fi991S8');

@Injectable()
export class ScannerService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ScannerService.name);
    private connection: Connection;
    private subscriptionId: number;
    private pumpPortalWs: WebSocket | null = null;
    private readonly PUMP_PORTAL_URL = 'wss://pumpportal.fun/api/data';
    // Map<tokenMint, expiredAt> — koin dihapus otomatis setelah TTL biar bisa di-re-check nanti
    private readonly seenTokens = new Map<string, number>();
    // Batasi max token yang dipantau bersamaan biar nggak kelebihan memory
    private activeMonitoring = 0;
    private readonly MAX_CONCURRENT = 10;

    constructor(
        private readonly configService: ConfigService,
        private readonly tradeService: TradeService,
        private readonly analyzerService: AnalyzerService,
        private readonly reportingService: ReportingService,
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

        // 1. Start WebSocket Discovery (Pump.fun Migrations)
        this.initPumpPortalWS();

        // 2. Start Polling Discovery (DexScreener Fallback)
        this.startDiscoveryPolling();
    }

    private initPumpPortalWS() {
        try {
            this.pumpPortalWs = new WebSocket(this.PUMP_PORTAL_URL);

            this.pumpPortalWs.on('open', () => {
                this.logger.log('🔌 Connected to PumpPortal WebSocket');
                // Subscribe to migrations to Raydium
                this.pumpPortalWs?.send(JSON.stringify({ method: "subscribeRaydiumLiquidity" }));
            });

            this.pumpPortalWs.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.mint) {
                        this.logger.log(`[PumpPortal] 💎 New Migration: ${message.mint}`);
                        this.handleWsDiscovery(message.mint);
                    }
                } catch (e) {
                    this.logger.error(`Error parsing PumpPortal message: ${e.message}`);
                }
            });

            this.pumpPortalWs.on('close', () => {
                this.logger.warn('🔌 PumpPortal WS closed. Reconnecting in 5s...');
                setTimeout(() => this.initPumpPortalWS(), 5000);
            });

            this.pumpPortalWs.on('error', (err) => {
                this.logger.error(`🔌 PumpPortal WS Error: ${err.message}`);
            });
        } catch (error) {
            this.logger.error(`Failed to init PumpPortal WS: ${error.message}`);
        }
    }

    private handleWsDiscovery(mint: string) {
        const now = Date.now();
        const expiredAt = this.seenTokens.get(mint);
        if (expiredAt && now < expiredAt) return;

        if (this.activeMonitoring >= this.MAX_CONCURRENT) return;

        // TTL 30 menit untuk koin dari WS (Lebih agresif dibanding polling)
        this.seenTokens.set(mint, now + 30 * 60 * 1000);
        this.processNewToken(mint);
    }

    onModuleDestroy() {
        if (this.subscriptionId && this.connection) {
            this.connection.removeProgramAccountChangeListener(this.subscriptionId);
        }
        if (this.pumpPortalWs) {
            this.pumpPortalWs.close();
        }
        this.logger.log('Scanner stopped');
    }


    private startDiscoveryPolling() {
        this.logger.log('Starting Trend Discovery Polling (Boosted & Trending)...');

        // Bersihkan seenTokens yang sudah expired setiap 10 menit
        setInterval(() => {
            const now = Date.now();
            for (const [mint, expiredAt] of this.seenTokens.entries()) {
                if (now > expiredAt) this.seenTokens.delete(mint);
            }
        }, 10 * 60 * 1000);

        // Poll setiap 30 detik ke 2 sumber berbeda
        setInterval(async () => {
            try {
                // Sumber 1: Token Boosts (koin dengan marketing budget)
                const boostRes = await axios.get(
                    'https://api.dexscreener.com/token-boosts/latest/v1',
                    { timeout: 10000 },
                );
                const boostTokens = (boostRes.data as Array<{ chainId: string; tokenAddress: string }>)
                    .filter((t) => t.chainId === 'solana')
                    .map((t) => t.tokenAddress);

                // Sumber 2: Trending Pairs (koin yang sedang ramai organik)
                let trendingTokens: string[] = [];
                try {
                    const trendRes = await axios.get(
                        'https://api.dexscreener.com/token-profiles/latest/v1',
                        { timeout: 10000 },
                    );
                    trendingTokens = (trendRes.data as Array<{ chainId: string; tokenAddress: string }>)
                        .filter((t) => t.chainId === 'solana')
                        .map((t) => t.tokenAddress);
                } catch {
                    // Sumber kedua opsional, gagal tidak masalah
                }

                // Gabungkan & deduplicate
                const allCandidates = [...new Set([...boostTokens, ...trendingTokens])];
                const now = Date.now();

                for (const mint of allCandidates) {
                    const expiredAt = this.seenTokens.get(mint);
                    if (expiredAt && now < expiredAt) continue; // Masih dalam cooldown

                    if (this.activeMonitoring >= this.MAX_CONCURRENT) {
                        this.logger.debug(`[Discovery] Max concurrent (${this.MAX_CONCURRENT}) reached. Skipping ${mint}.`);
                        continue;
                    }

                    // TTL 60 menit untuk koin yang baru masuk (Anti-Spam)
                    this.seenTokens.set(mint, now + 60 * 60 * 1000);
                    this.logger.log(`🔍 [Discovery] Potential Second-Wave Candidate: ${mint}`);

                    this.processNewToken(mint);
                    await new Promise((res) => setTimeout(res, 2000));
                }
            } catch (error) {
                if (error instanceof Error) {
                    this.logger.debug(`Discovery Polling error: ${error.message}`);
                }
            }
        }, 30000);
    }

    // Map<tokenMint, notifiedAt> — koin nggak bakal di-notif lagi selama 6 jam biarpun masuk monitor lagi
    private readonly notifiedTokens = new Map<string, number>();

    private async processNewToken(tokenMint: string) {
        this.activeMonitoring++;
        this.logger.log(`[${tokenMint}] Monitoring for traction... [Active: ${this.activeMonitoring}/${this.MAX_CONCURRENT}]`);

        const startTime = Date.now();
        const maxWaitTime = 10 * 60 * 1000;
        let localNotified = false;

        // Bersihkan notifiedTokens yang sudah > 6 jam
        const now = Date.now();
        for (const [mint, time] of this.notifiedTokens.entries()) {
            if (now - time > 6 * 60 * 60 * 1000) this.notifiedTokens.delete(mint);
        }

        try {
            while (Date.now() - startTime < maxWaitTime) {
                try {
                    const result = await this.analyzerService.isTokenSafeToBuy(tokenMint);

                    // 🛡️ HARDENED ANTI-SPAM (V2)
                    const surge = result.metadata?.volumeSurge || 0;
                    const mcap = result.metadata?.mcap || 0;
                    const ageHours = result.metadata?.pairCreatedAt ? (Date.now() - result.metadata.pairCreatedAt) / (1000 * 60 * 60) : 0;
                    
                    // SYARAT NOTIF (Lebih Ketat biar gak spam): 
                    // 1. Belum di-notif (local & global 6h)
                    // 2. Ada metadata & MCap masuk akal (Min $20k)
                    // 3. Surge beneran panas (> 1.5x)
                    // 4. Umur minimal masuk kriteria (1.5h+)
                    if (!localNotified && !this.notifiedTokens.has(tokenMint) && result.metadata && mcap >= 20000 && ageHours >= 1.5 && surge >= 1.5) {
                        await this.reportingService.sendWatchlistNotification(
                            tokenMint, 
                            mcap, 
                            ageHours, 
                            result.metadata.symbol,
                            surge
                        );
                        localNotified = true;
                        this.notifiedTokens.set(tokenMint, Date.now());
                        this.logger.log(`[${tokenMint}] 🔔 Telegram Alert sent!`);
                    }

                    if (result.safe) {
                        this.logger.log(`[${tokenMint}] 🚀 Traction detected! Attempting to buy...`);
                        await this.tradeService.attemptBuy(tokenMint, result.metadata);
                        return;
                    }

                    if (result.permanent) {
                        this.logger.debug(`[${tokenMint}] ⛔ Permanent filter fail (${result.reason}). Giving up immediately.`);
                        // Hapus dari seenTokens supaya bisa di-re-evaluate kalau nanti kondisinya berubah
                        this.seenTokens.delete(tokenMint);
                        return;
                    }

                    if (result.reason && result.reason !== 'low_traction') {
                        this.logger.warn(`[${tokenMint}] ⚠️ Safety failed (${result.reason}). Waiting 30s to re-check...`);
                    } else {
                        this.logger.log(`[${tokenMint}] Still quiet... waiting 30s to re-check.`);
                    }

                    await new Promise((res) => setTimeout(res, 30000));
                } catch (error) {
                    if (error instanceof Error) {
                        this.logger.error(`Error processing token ${tokenMint}: ${error.message}`);
                    }
                    break;
                }
            }

            this.logger.log(`[${tokenMint}] 💤 Token remained quiet after 10 minutes. Giving up.`);
            // Setelah 10 menit, hapus dari seenTokens supaya kalau koin ini trending lagi bisa ditangkap
            this.seenTokens.delete(tokenMint);
        } finally {
            this.activeMonitoring--;
        }
    }
}
