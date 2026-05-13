import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection } from '@solana/web3.js';
import axios from 'axios';
import * as WebSocket from 'ws';
import { AnalyzerService } from '../analyzer/analyzer.service';
import { TradeService } from '../trade/trade.service';
import { ReportingService } from '../reporting/reporting.service';
import { PrismaService } from '../prisma/prisma.service';

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
    private readonly MAX_CONCURRENT: number;

    constructor(
        private readonly configService: ConfigService,
        private readonly tradeService: TradeService,
        private readonly analyzerService: AnalyzerService,
        private readonly reportingService: ReportingService,
        private readonly prismaService: PrismaService,
    ) {
        this.MAX_CONCURRENT = Number.parseInt(this.configService.get<string>('SCANNER_MAX_CONCURRENT', '100'), 10);
    }

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

        // 3. Start Persistent Watchlist Monitoring
        this.startWatchlistMonitoring();
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

        // Poll setiap 15 detik ke 2 sumber berbeda
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

                    this.activeMonitoring++;
                    this.processNewToken(mint);
                }
            } catch (error) {
                if (error instanceof Error) {
                    this.logger.debug(`Discovery Polling error: ${error.message}`);
                }
            }
        }, Number.parseInt(this.configService.get<string>('SCANNER_POLLING_INTERVAL', '15000'), 10));

        // Heartbeat Log: Biar Amirull tahu bot masih hidup & nyari koin
        setInterval(() => {
            this.logger.debug(`💓 [Heartbeat] Scanner Active: ${this.activeMonitoring}/${this.MAX_CONCURRENT} | Seen: ${this.seenTokens.size} tokens`);
        }, Number.parseInt(this.configService.get<string>('SCANNER_HEARTBEAT_INTERVAL', '30000'), 10));
    }

    private startWatchlistMonitoring() {
        this.logger.log('Starting Persistent Watchlist Radar...');

        // Re-check PENDING koin dari DB setiap 60 detik
        setInterval(async () => {
            try {
                const pending = await this.prismaService.watchlist.findMany({
                    where: { status: 'PENDING' },
                    orderBy: { createdAt: 'desc' },
                    take: 20 // Ambil 20 koin terbaru biar gak bottleneck
                });

                for (const item of pending) {
                    // Jika koin sudah di-scan secara live, skip biar nggak double
                    if (this.activeMonitoring >= this.MAX_CONCURRENT) continue;
                    
                    this.activeMonitoring++;
                    this.processNewToken(item.tokenMint);
                    await new Promise(res => setTimeout(res, 500)); // Lebih cepat re-check-nya
                }
                
                // Cleanup Watchlist: Hapus koin yang sudah > 24 jam dan gagal/pending
                const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                await this.prismaService.watchlist.deleteMany({
                    where: { 
                        createdAt: { lt: dayAgo },
                        status: { in: ['FAILED', 'PENDING'] }
                    }
                });
            } catch (error) {
                this.logger.error(`Watchlist Monitoring error: ${error.message}`);
            }
        }, Number.parseInt(this.configService.get<string>('SCANNER_RADAR_INTERVAL', '20000'), 10));
    }

    // Map<tokenMint, notifiedAt> — koin nggak bakal di-notif lagi selama 6 jam biarpun masuk monitor lagi
    private readonly notifiedTokens = new Map<string, number>();

    public getScannerStatus() {
        return {
            active: this.activeMonitoring,
            max: this.MAX_CONCURRENT,
            seen: this.seenTokens.size,
            notified: this.notifiedTokens.size
        };
    }

    private async processNewToken(tokenMint: string) {
        // Jika dipanggil dari radar/poll yang sudah increment, jangan double increment
        // Tapi kita handle increment di pemanggil biar race-condition free.
        // Di sini kita pastikan decrement tetap jalan di finally.
        
        try {
            // 🛡️ Tembok Pelindung: Cek dulu status di DB. Kalau sudah FAILED/TRADED, jangan diproses lagi.
            const existing = await this.prismaService.watchlist.findUnique({
                where: { tokenMint }
            });

            if (existing && (existing.status === 'FAILED' || existing.status === 'TRADED')) {
                // Khusus FAILED, kita hapus dari seenTokens biar nggak kena log debug terus-menerus
                this.seenTokens.set(tokenMint, Date.now() + 2 * 60 * 60 * 1000); // Cooldown 2 jam biar nggak masuk discovery lagi
                return;
            }

            this.logger.log(`[${tokenMint}] Monitoring for traction... [Active: ${this.activeMonitoring}/${this.MAX_CONCURRENT}]`);

            const startTime = Date.now();
            const maxWaitMin = Number.parseInt(this.configService.get<string>('ANALYZER_MAX_SCAN_DURATION_MIN', '10'), 10);
            const maxWaitTime = maxWaitMin * 60 * 1000;
            let localNotified = false;

            // Bersihkan notifiedTokens yang sudah > 6 jam
            const now = Date.now();
            for (const [mint, time] of this.notifiedTokens.entries()) {
                if (now - time > 6 * 60 * 60 * 1000) this.notifiedTokens.delete(mint);
            }

            // Upsert ke Watchlist sebagai PENDING di awal & increment checkCount
            await this.prismaService.watchlist.upsert({
                where: { tokenMint },
                update: { 
                    lastCheckedAt: new Date(),
                    checkCount: { increment: 1 } 
                },
                create: { 
                    tokenMint, 
                    status: 'PENDING',
                    checkCount: 1
                }
            });

            while (Date.now() - startTime < maxWaitTime) {
                try {
                    const result = await this.analyzerService.isTokenSafeToBuy(tokenMint);

                    // Update metadata di Watchlist
                    if (result.metadata) {
                        await this.prismaService.watchlist.update({
                            where: { tokenMint },
                            data: {
                                symbol: result.metadata.symbol,
                                mcap: result.metadata.mcap,
                                liquidity: result.metadata.liquidity,
                                volumeSurge: result.metadata.volumeSurge,
                                lastCheckedAt: new Date()
                            }
                        });
                    }

                    // 🛡️ HARDENED ANTI-SPAM (V2)
                    const surge = result.metadata?.volumeSurge || 0;
                    const mcap = result.metadata?.mcap || 0;
                    const ageHours = result.metadata?.pairCreatedAt ? (Date.now() - result.metadata.pairCreatedAt) / (1000 * 60 * 60) : 0;
                    
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
                        const buyResult = await this.tradeService.attemptBuy(tokenMint, result.metadata);
                        
                        if (buyResult.success) {
                            await this.prismaService.watchlist.update({
                                where: { tokenMint },
                                data: { status: 'TRADED' }
                            });
                        }
                        return;
                    }

                    if (result.permanent) {
                        this.logger.debug(`[${tokenMint}] ⛔ Permanent filter fail (${result.reason}). Giving up.`);
                        await this.prismaService.watchlist.update({
                            where: { tokenMint },
                            data: { status: 'FAILED', reason: result.reason }
                        });
                        this.seenTokens.delete(tokenMint);
                        return;
                    }

                    // 🧠 SMART RETRY: Kalau cuma "muda", "MCap kecil", "Volume sepi", atau "RPC lemot", jangan jadikan FAILED.
                    // Biarkan tetap PENDING supaya di-recheck sama background radar nanti.
                    if (result.reason === 'too_young' || 
                        result.reason === 'mcap_too_low' || 
                        result.reason === 'low_surge' || 
                        result.reason === 'safety_rpc_failed' ||
                        result.reason === 'bearish_trend' ||
                        result.reason === 'low_buy_confidence'
                    ) {
                        this.logger.debug(`[${tokenMint}] ⏳ Temporary fail (${result.reason}). Keeping in Watchlist for re-check.`);
                        
                        // Tapi kalau sudah dicek > 150 kali dan masih PENDING, kita FAILED-kan saja (Basi)
                        const currentWatchlist = await this.prismaService.watchlist.findUnique({ where: { tokenMint } });
                        if (currentWatchlist && currentWatchlist.checkCount > 150) {
                            await this.prismaService.watchlist.update({
                                where: { tokenMint },
                                data: { status: 'FAILED', reason: 'stagnant_timeout' }
                            });
                        }
                        return; 
                    }

                    if (result.reason) {
                        await this.prismaService.watchlist.update({
                            where: { tokenMint },
                            data: { reason: result.reason }
                        });
                    }

                    await new Promise((res) => setTimeout(res, Number.parseInt(this.configService.get<string>('SCANNER_RECHECK_DELAY_MS', '30000'), 10)));
                } catch (error) {
                    if (error instanceof Error) {
                        this.logger.error(`Error processing token ${tokenMint}: ${error.message}`);
                    }
                    break;
                }
            }

            this.logger.log(`[${tokenMint}] 💤 Token remained quiet after 10 minutes.`);
            this.seenTokens.delete(tokenMint);
        } finally {
            this.activeMonitoring--;
        }
    }
}
