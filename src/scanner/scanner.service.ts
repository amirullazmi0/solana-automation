import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection } from '@solana/web3.js';
import axios from 'axios';
import * as WebSocket from 'ws';
import * as https from 'https';
import { AnalyzerService } from '../analyzer/analyzer.service';
import { EstablishedAnalyzerService } from '../analyzer/established-analyzer.service';
import { TradeService } from '../trade/trade.service';
import { ReportingService } from '../reporting/reporting.service';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleRef } from '@nestjs/core';
import { DexLimiter } from '../common/dex-limiter';
import { Prisma } from '@prisma/client';

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
    private readonly processingTokens = new Set<string>();
    private readonly httpsAgent: https.Agent;

    // Cache for resolved IPs
    private ipCache: Record<string, string> = {
        '1.1.1.1': '1.1.1.1',
        '8.8.8.8': '8.8.8.8',
    };
    private readonly fallbackApiIps: Record<string, string> = {
        'api.dexscreener.com': '104.26.13.233',
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly analyzerService: AnalyzerService,
        private readonly establishedAnalyzerService: EstablishedAnalyzerService,
        private readonly prismaService: PrismaService,
        private readonly moduleRef: ModuleRef,
    ) {
        this.MAX_CONCURRENT = Number.parseInt(
            this.configService.get<string>('SCANNER_MAX_CONCURRENT', '100'),
            10,
        );

        // Inisialisasi DNS Hardening HTTPS Agent dengan keepAlive
        this.httpsAgent = new https.Agent({
            family: 4,
            keepAlive: true,
            lookup: async (hostname, options, cb) => {
                try {
                    const ip = await this.resolveDns(hostname);
                    if (ip) {
                        cb(null, ip, 4);
                    } else {
                        import('dns')
                            .then(({ lookup: dnsLookup }) => {
                                dnsLookup(hostname, options, cb);
                            })
                            .catch((err) => {
                                cb(err, '', 4);
                            });
                    }
                } catch (e) {
                    cb(e as Error, '', 4);
                }
            },
        });
    }

    private get tradeService(): TradeService {
        return this.moduleRef.get(TradeService, { strict: false });
    }

    private get reportingService(): ReportingService {
        return this.moduleRef.get(ReportingService, { strict: false });
    }

    onModuleInit() {
        const wssEndpoint = this.configService.get<string>('WSS_ENDPOINT');
        const rpcEndpoint = this.configService.get<string>('RPC_ENDPOINT');
        const botMode = this.configService.get<string>('BOT_MODE', 'micin');

        if (!wssEndpoint || !rpcEndpoint) {
            this.logger.error('RPC or WSS endpoints not configured. Scanner will not start.');
            return;
        }

        this.connection = new Connection(rpcEndpoint, {
            wsEndpoint: wssEndpoint,
            commitment: 'confirmed',
        });

        this.logger.log(`🤖 Bot Mode: ${botMode.toUpperCase()}`);

        if (botMode === 'micin') {
            // 1. Start WebSocket Discovery (Pump.fun Migrations) — ONLY in micin mode
            this.initPumpPortalWS();
            this.logger.log('🔌 PumpPortal WS ENABLED (Micin Sniper Mode)');
        } else {
            this.logger.log('🐋 PumpPortal WS DISABLED (Second Whale Mode — DexScreener Only)');
        }

        // 2. Start Polling Discovery (DexScreener — Always Active)
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
                this.pumpPortalWs?.send(JSON.stringify({ method: 'subscribeRaydiumLiquidity' }));
            });

            this.pumpPortalWs.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.mint) {
                        this.logger.log(`[PumpPortal] 💎 New Migration: ${message.mint}`);
                        this.handleWsDiscovery(message.mint);
                    }
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    this.logger.error(`Error parsing PumpPortal message: ${msg}`);
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
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to init PumpPortal WS: ${msg}`);
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
        setInterval(
            () => {
                const now = Date.now();
                for (const [mint, expiredAt] of this.seenTokens.entries()) {
                    if (now > expiredAt) this.seenTokens.delete(mint);
                }
            },
            10 * 60 * 1000,
        );

        // Poll setiap 15 detik ke 2 sumber berbeda
        setInterval(
            async () => {
                try {
                    // Sumber 1: Token Boosts (koin dengan marketing budget)
                    const boostRes = await DexLimiter.get<
                        Array<{ chainId: string; tokenAddress: string }>
                    >('https://api.dexscreener.com/token-boosts/latest/v1', {
                        timeout: 10000,
                        httpsAgent: this.httpsAgent,
                    });
                    const boostTokens = boostRes.data
                        .filter((t) => t.chainId === 'solana')
                        .map((t) => t.tokenAddress);

                    // Sumber 2: Trending Pairs (koin yang sedang ramai organik)
                    let trendingTokens: string[] = [];
                    try {
                        const trendRes = await DexLimiter.get<
                            Array<{ chainId: string; tokenAddress: string }>
                        >('https://api.dexscreener.com/token-profiles/latest/v1', {
                            timeout: 10000,
                            httpsAgent: this.httpsAgent,
                        });
                        trendingTokens = trendRes.data
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
                            this.logger.debug(
                                `[Discovery] Max concurrent (${this.MAX_CONCURRENT}) reached. Skipping ${mint}.`,
                            );
                            continue;
                        }

                        // TTL 6 jam untuk koin yang baru masuk (Anti-Spam — mencegah re-discovery loop)
                        this.seenTokens.set(mint, now + 6 * 60 * 60 * 1000);
                        this.logger.log(`🔍 [Discovery] Potential Second-Wave Candidate: ${mint}`);

                        this.processNewToken(mint);
                    }
                } catch (error) {
                    if (error instanceof Error) {
                        this.logger.debug(`Discovery Polling error: ${error.message}`);
                    }
                }
            },
            Number.parseInt(
                this.configService.get<string>('SCANNER_POLLING_INTERVAL', '15000'),
                10,
            ),
        );

        // Heartbeat Log: Biar Amirull tahu bot masih hidup & nyari koin
        setInterval(
            () => {
                this.logger.debug(
                    `💓 [Heartbeat] Scanner Active: ${this.activeMonitoring}/${this.MAX_CONCURRENT} | Seen: ${this.seenTokens.size} tokens`,
                );
            },
            Number.parseInt(
                this.configService.get<string>('SCANNER_HEARTBEAT_INTERVAL', '30000'),
                10,
            ),
        );
    }

    private startWatchlistMonitoring() {
        this.logger.log('Starting Persistent Watchlist Radar...');

        // Re-check PENDING koin dari DB setiap 60 detik
        setInterval(
            async () => {
                try {
                    const pending = await this.prismaService.watchlist.findMany({
                        where: {
                            status: 'PENDING',
                            // Hindari re-check koin yang baru dicek kurang dari 3 menit lalu (mencegah loop koin tertua)
                            lastCheckedAt: { lt: new Date(Date.now() - 3 * 60 * 1000) },
                        },
                        orderBy: [{ pairCreatedAt: 'asc' }, { createdAt: 'asc' }],
                        take: 20, // Ambil hingga 50 koin
                        select: { tokenMint: true }, // Optimasi memory leak
                    });

                    for (const item of pending) {
                        // Jika koin sudah di-scan secara live, skip biar nggak double
                        if (this.activeMonitoring >= this.MAX_CONCURRENT) continue;

                        this.processNewToken(item.tokenMint);
                        await new Promise((res) => setTimeout(res, 100)); // Stagger 100ms agar aman dari rate limit
                    }

                    // Cleanup Watchlist: Hapus koin yang sudah > 24 jam dan gagal/pending
                    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                    await this.prismaService.watchlist.deleteMany({
                        where: {
                            createdAt: { lt: dayAgo },
                            status: { in: ['FAILED', 'PENDING'] },
                        },
                    });
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    this.logger.error(`Watchlist Monitoring error: ${msg}`);
                }
            },
            Number.parseInt(this.configService.get<string>('SCANNER_RADAR_INTERVAL', '20000'), 10),
        );
    }

    // Map<tokenMint, notifiedAt> — koin nggak bakal di-notif lagi selama 6 jam biarpun masuk monitor lagi
    private readonly notifiedTokens = new Map<string, number>();

    public getScannerStatus() {
        return {
            active: this.activeMonitoring,
            max: this.MAX_CONCURRENT,
            seen: this.seenTokens.size,
            notified: this.notifiedTokens.size,
        };
    }

    private async updateWatchlistByMint(
        tokenMint: string,
        data: Prisma.WatchlistUpdateManyMutationInput,
    ): Promise<boolean> {
        const result = await this.prismaService.watchlist.updateMany({
            where: { tokenMint },
            data,
        });

        if (result.count === 0) {
            this.logger.warn(`[${tokenMint}] Watchlist row no longer exists. Stopping monitor.`);
            return false;
        }

        return true;
    }

    private getTradeCooldown(recentTrade: { profitUsd: number | null; updatedAt: Date }): {
        isWin: boolean;
        cooldownHours: number;
        expiredAt: number;
    } {
        const winCooldownHours = Number.parseInt(
            this.configService.get<string>('COOLDOWN_WIN_HOURS', '6'),
            10,
        );
        const lossCooldownHours = Number.parseInt(
            this.configService.get<string>('COOLDOWN_LOSS_HOURS', '24'),
            10,
        );
        const isWin = (recentTrade.profitUsd || 0) > 0;
        const cooldownHours = isWin ? winCooldownHours : lossCooldownHours;
        const expiredAt = recentTrade.updatedAt.getTime() + cooldownHours * 60 * 60 * 1000;

        return { isWin, cooldownHours, expiredAt };
    }

    private async processNewToken(tokenMint: string) {
        if (this.processingTokens.has(tokenMint)) return;

        let incremented = false;
        try {
            if (this.activeMonitoring >= this.MAX_CONCURRENT) {
                return;
            }
            this.processingTokens.add(tokenMint);
            this.activeMonitoring++;
            incremented = true;
            // 🛡️ Tembok Pelindung: Cek dulu status di DB. Kalau sudah FAILED/TRADED, jangan diproses lagi.
            const existing = await this.prismaService.watchlist.findUnique({
                where: { tokenMint },
            });

            if (existing && (existing.status === 'FAILED' || existing.status === 'TRADED')) {
                const isTempFail = [
                    'already_traded_24h',
                    'cooldown_win',
                    'cooldown_loss',
                    'stagnant_timeout',
                    'signal_only',
                ].includes(existing.reason || '');
                if (existing.status === 'TRADED' || isTempFail) {
                    const recentTrade = await this.prismaService.trade.findFirst({
                        where: { tokenMint, mode: 'LIVE' },
                        orderBy: { createdAt: 'desc' },
                    });

                    let expired = false;
                    let cooldownExpiredAt = 0;

                    if (recentTrade) {
                        if (recentTrade.status === 'OPEN') {
                            this.seenTokens.set(tokenMint, Date.now() + 6 * 60 * 60 * 1000);
                            return;
                        }
                        const cooldown = this.getTradeCooldown(recentTrade);
                        cooldownExpiredAt = cooldown.expiredAt;
                        expired = Date.now() >= cooldownExpiredAt;
                    } else if (existing.status === 'TRADED') {
                        cooldownExpiredAt = existing.lastCheckedAt.getTime() + 24 * 60 * 60 * 1000;
                        expired = Date.now() >= cooldownExpiredAt;
                    } else {
                        cooldownExpiredAt = existing.lastCheckedAt.getTime() + 6 * 60 * 60 * 1000;
                        expired = Date.now() >= cooldownExpiredAt;
                    }

                    if (expired) {
                        this.logger.log(
                            `[${tokenMint}] 🔄 Cooldown expired. Resetting watchlist status to PENDING.`,
                        );
                        await this.updateWatchlistByMint(tokenMint, {
                            status: 'PENDING',
                            reason: null,
                            checkCount: 0,
                        });
                        this.seenTokens.delete(tokenMint);
                    } else {
                        this.seenTokens.set(tokenMint, cooldownExpiredAt);
                        return;
                    }
                } else {
                    this.seenTokens.set(tokenMint, Date.now() + 6 * 60 * 60 * 1000);
                    return;
                }
            }

            // 🚀 PROTEKSI STAGNANT: Hentikan loop retry jika koin sudah di-check >= 50 kali
            if (existing && existing.checkCount >= 50 && existing.status === 'PENDING') {
                this.logger.log(
                    `[${tokenMint}] ⏳ Stagnant timeout reached (${existing.checkCount} checks). Marking as FAILED.`,
                );
                await this.updateWatchlistByMint(tokenMint, {
                    status: 'FAILED',
                    reason: 'stagnant_timeout',
                });
                this.seenTokens.set(tokenMint, Date.now() + 6 * 60 * 60 * 1000); // Cooldown 6 jam
                return;
            }

            // 🛡️ ANTI-REPEAT BUY: Cek apakah token ini sedang dalam cooldown
            const recentTrade = await this.prismaService.trade.findFirst({
                where: { tokenMint, mode: 'LIVE' },
                orderBy: { createdAt: 'desc' },
            });
            if (recentTrade) {
                if (recentTrade.status === 'OPEN') {
                    this.logger.debug(
                        `[${tokenMint}] ⛔ Already holding this token (Trade #${recentTrade.id}). Skip.`,
                    );
                    return;
                }
                const { isWin, cooldownHours, expiredAt: cooldownExpiredAt } =
                    this.getTradeCooldown(recentTrade);

                if (Date.now() < cooldownExpiredAt) {
                    this.logger.debug(
                        `[${tokenMint}] ⛔ Token is in cooldown until ${new Date(cooldownExpiredAt).toISOString()} (Last outcome: ${isWin ? 'WIN' : 'LOSS'}, Cooldown: ${cooldownHours}h). Skip.`,
                    );
                    await this.prismaService.watchlist.upsert({
                        where: { tokenMint },
                        update: { status: 'FAILED', reason: `cooldown_${isWin ? 'win' : 'loss'}` },
                        create: {
                            tokenMint,
                            status: 'FAILED',
                            reason: `cooldown_${isWin ? 'win' : 'loss'}`,
                        },
                    });
                    this.seenTokens.set(tokenMint, cooldownExpiredAt);
                    return;
                }
            }

            this.logger.log(
                `[${tokenMint}] Monitoring for traction... [Active: ${this.activeMonitoring}/${this.MAX_CONCURRENT}]`,
            );

            const startTime = Date.now();
            const maxWaitMin = Number.parseInt(
                this.configService.get<string>('ANALYZER_MAX_SCAN_DURATION_MIN', '10'),
                10,
            );
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
                    checkCount: { increment: 1 },
                },
                create: {
                    tokenMint,
                    status: 'PENDING',
                    checkCount: 1,
                },
            });

            while (Date.now() - startTime < maxWaitTime) {
                try {
                    // Update checkCount & lastCheckedAt in DB at the start of each iteration
                    const watchlistExists = await this.updateWatchlistByMint(tokenMint, {
                        lastCheckedAt: new Date(),
                        checkCount: { increment: 1 },
                    });
                    if (!watchlistExists) return;

                    // 🛡️ RE-FETCH LATEST DATA
                    const currentItem = await this.prismaService.watchlist.findUnique({
                        where: { tokenMint },
                    });
                    if (
                        !currentItem ||
                        currentItem.status === 'FAILED' ||
                        currentItem.status === 'TRADED'
                    )
                        return;

                    // 🚀 STAGNANT TIMEOUT CHECK INSIDE LOOP
                    if (currentItem.checkCount >= 50) {
                        this.logger.log(
                            `[${tokenMint}] ⏳ Stagnant timeout reached in active loop (${currentItem.checkCount} checks). Marking as FAILED.`,
                        );
                        await this.updateWatchlistByMint(tokenMint, {
                            status: 'FAILED',
                            reason: 'stagnant_timeout',
                        });
                        this.seenTokens.set(tokenMint, Date.now() + 6 * 60 * 60 * 1000); // Cooldown 6 jam
                        return;
                    }

                    // 🚀 ESTABLISHED REBOUND & CTO BOT SERVICE (Lapis 1)
                    const reboundResult =
                        await this.establishedAnalyzerService.analyzeAndExecuteRebound(tokenMint);
                    if (reboundResult.isEstablished && reboundResult.executed) {
                        await this.updateWatchlistByMint(tokenMint, { status: 'TRADED' });
                        return; // Selesai jika sudah ditransaksikan via rebound
                    }

                    // 🔄 ESTABLISHED FALL-THROUGH: Jika rebound gagal karena safety/security,
                    // retry di loop. Jika gagal karena market metrics, FALL-THROUGH ke standard analyzer.
                    if (reboundResult.isEstablished && !reboundResult.executed) {
                        if (reboundResult.reason === 'signal_only') {
                            await this.updateWatchlistByMint(tokenMint, {
                                status: 'FAILED',
                                reason: 'signal_only',
                            });
                            this.seenTokens.set(tokenMint, Date.now() + 6 * 60 * 60 * 1000);
                            return;
                        }

                        const securityFailReasons = [
                            'established_security_authority_failed',
                            'established_rugcheck_failed',
                            'established_creator_blacklisted',
                            'established_honeypot_detected',
                            'established_high_concentration',
                            'established_danger_risks_detected',
                            'established_high_risk_score',
                            'established_creator_holds_too_much',
                            'rugcheck_api_error',
                            'rebound_analysis_error',
                        ];
                        const isSafetyFail = securityFailReasons.some((r) =>
                            reboundResult.reason?.includes(r),
                        );

                        if (isSafetyFail) {
                            // Security/safety issue → update reason & retry di loop
                            if (reboundResult.reason) {
                                await this.updateWatchlistByMint(tokenMint, {
                                    reason: reboundResult.reason,
                                });
                            }
                            this.logger.debug(
                                `[${tokenMint}] ⏳ Established safety fail (${reboundResult.reason}). Retrying rebound path...`,
                            );
                            await new Promise((res) =>
                                setTimeout(
                                    res,
                                    Number.parseInt(
                                        this.configService.get<string>(
                                            'SCANNER_RECHECK_DELAY_MS',
                                            '30000',
                                        ),
                                        10,
                                    ),
                                ),
                            );
                            continue;
                        }

                        // Market metrics fail (rebound_not_triggered, low_buyer_dominance, etc.)
                        // → FALL-THROUGH ke standard isTokenSafeToBuy di bawah! 🎯
                        this.logger.debug(
                            `[${tokenMint}] 🔄 Established rebound not triggered (${reboundResult.reason}). Falling through to standard analyzer...`,
                        );
                    }

                    const result = await this.analyzerService.isTokenSafeToBuy(tokenMint);

                    // Update metadata di Watchlist
                    if (result.metadata) {
                        await this.updateWatchlistByMint(tokenMint, {
                            symbol: result.metadata.symbol,
                            mcap: result.metadata.mcap,
                            liquidity: result.metadata.liquidity,
                            volumeSurge: result.metadata.volumeSurge,
                            volScore: result.metadata.volScore,
                            zScore: result.metadata.zScore,
                            priceChange1h: result.metadata.priceChange1h,
                            isPumpFun: result.metadata.isPumpFun || false,
                            pairCreatedAt: result.metadata.pairCreatedAt
                                ? new Date(result.metadata.pairCreatedAt)
                                : null,
                            lastCheckedAt: new Date(),
                        });
                    }

                    // 🛡️ HARDENED ANTI-SPAM (V2)
                    const surge = result.metadata?.volumeSurge || 0;
                    const mcap = result.metadata?.mcap || 0;
                    const ageHours = result.metadata?.pairCreatedAt
                        ? (Date.now() - result.metadata.pairCreatedAt) / (1000 * 60 * 60)
                        : 0;

                    const isCTO = result.metadata?.isCTO || false;
                    const botMode = this.configService.get<string>('BOT_MODE', 'micin');
                    const minAgeForNotif = botMode === 'micin' ? 0.05 : 1.5;
                    const minMcapForNotif = botMode === 'micin' ? 5000 : 20000;

                    if (
                        !localNotified &&
                        !this.notifiedTokens.has(tokenMint) &&
                        result.metadata &&
                        mcap >= minMcapForNotif &&
                        ageHours >= minAgeForNotif &&
                        surge >= 1.5
                    ) {
                        await this.reportingService.sendWatchlistNotification(
                            tokenMint,
                            mcap,
                            ageHours,
                            result.metadata.symbol,
                            surge,
                            isCTO,
                        );
                        localNotified = true;
                        this.notifiedTokens.set(tokenMint, Date.now());
                        this.logger.log(`[${tokenMint}] 🔔 Telegram Alert sent! (isCTO: ${isCTO})`);
                    }

                    if (result.safe) {
                        const activeChats = await this.prismaService.telegramChat.findMany({
                            where: { status: 'ACTIVE' },
                            include: { settings: true, walletVault: true },
                            orderBy: { updatedAt: 'desc' },
                        });

                        let liveBuyExecuted = false;
                        let signalOnlySent = false;

                        for (const chat of activeChats) {
                            const chatDryRun = chat.settings?.dryRun ?? true;
                            this.logger.log(
                                `[AutoBuyTrace] token=${tokenMint} chat=${chat.chatId} dryRun=${chatDryRun} wallet=${chat.walletVault?.publicKey || 'n/a'}`,
                            );

                            if (chatDryRun) {
                                signalOnlySent = true;
                                this.logger.log(
                                    `[${tokenMint}] MUST BUY signal detected for chat ${chat.chatId}. Dry run enabled, sending signal only.`,
                                );
                                await this.reportingService.sendBuySignalAlert(
                                    tokenMint,
                                    result.metadata,
                                    undefined,
                                    true,
                                    chat.chatId,
                                );
                                continue;
                            }

                            this.logger.log(
                                `[${tokenMint}] Auto-buy enabled for chat ${chat.chatId}. Attempting to buy...`,
                            );
                            await this.reportingService.sendBuySignalAlert(
                                tokenMint,
                                result.metadata,
                                undefined,
                                false,
                                chat.chatId,
                            );
                            const buyResult = await this.tradeService.attemptBuy(
                                tokenMint,
                                result.metadata,
                                undefined,
                                undefined,
                                chat.chatId,
                            );

                            this.logger.log(
                                `[AutoBuyTrace] result token=${tokenMint} chat=${chat.chatId} success=${buyResult.success} message=${buyResult.message}`,
                            );

                            if (buyResult.success) {
                                liveBuyExecuted = true;
                            } else {
                                this.logger.warn(
                                    `[${tokenMint}] Auto-buy failed for chat ${chat.chatId}: ${buyResult.message}`,
                                );
                            }
                        }

                        await this.updateWatchlistByMint(tokenMint, {
                            status: liveBuyExecuted ? 'TRADED' : 'FAILED',
                            reason: liveBuyExecuted ? undefined : signalOnlySent ? 'signal_only' : 'auto_buy_failed',
                        });
                        this.seenTokens.set(tokenMint, Date.now() + 6 * 60 * 60 * 1000);
                        return;
                    }

                    if (result.permanent) {
                        this.logger.debug(
                            `[${tokenMint}] ⛔ Permanent filter fail (${result.reason}). Giving up.`,
                        );
                        await this.updateWatchlistByMint(tokenMint, {
                            status: 'FAILED',
                            reason: result.reason,
                        });
                        // Cooldown 6 jam biar nggak masuk discovery lagi
                        this.seenTokens.set(tokenMint, Date.now() + 6 * 60 * 60 * 1000);
                        return;
                    }

                    // 🧠 SMART RETRY: Jika kegagalan bersifat sementara (tidak permanen),
                    // biarkan status tetap PENDING agar dicek kembali oleh background radar nanti,
                    // dan teruskan pemantauan aktif di loop ini hanya jika itu adalah error API/Network.
                    if (!result.permanent && result.reason) {
                        const isApiOrNetworkError = [
                            'rugcheck_error',
                            'rebound_analysis_error',
                            'error',
                            'no_dex_pair',
                        ].includes(result.reason);

                        if (isApiOrNetworkError) {
                            this.logger.debug(
                                `[${tokenMint}] ⏳ API/Network temporary fail (${result.reason}). Retrying actively.`,
                            );
                            await new Promise((res) =>
                                setTimeout(
                                    res,
                                    Number.parseInt(
                                        this.configService.get<string>(
                                            'SCANNER_RECHECK_DELAY_MS',
                                            '30000',
                                        ),
                                        10,
                                    ),
                                ),
                            );
                            continue; // Lanjut loop pemantauan aktif
                        } else {
                            this.logger.debug(
                                `[${tokenMint}] ⏳ Market metric temporary fail (${result.reason}). Exiting active monitor to let background radar handle it.`,
                            );
                            return; // Keluar dari monitor aktif, biarkan status tetap PENDING
                        }
                    }

                    if (result.reason) {
                        await this.updateWatchlistByMint(tokenMint, { reason: result.reason });
                    }

                    await new Promise((res) =>
                        setTimeout(
                            res,
                            Number.parseInt(
                                this.configService.get<string>('SCANNER_RECHECK_DELAY_MS', '30000'),
                                10,
                            ),
                        ),
                    );
                } catch (error) {
                    if (error instanceof Error) {
                        this.logger.error(`Error processing token ${tokenMint}: ${error.message}`);
                    }
                    break;
                }
            }

            this.logger.log(`[${tokenMint}] 💤 Token remained quiet after ${maxWaitMin} minutes.`);
            await this.updateWatchlistByMint(tokenMint, {
                status: 'FAILED',
                reason: 'stagnant_timeout',
            });
            this.seenTokens.delete(tokenMint);
        } finally {
            if (incremented) {
                this.activeMonitoring--;
            }
            this.processingTokens.delete(tokenMint);
        }
    }

    /**
     * Helper to resolve DNS using Cloudflare/Google DNS-over-HTTPS if standard lookup fails
     */
    private async resolveDns(hostname: string): Promise<string | null> {
        if (this.ipCache[hostname]) return this.ipCache[hostname];

        try {
            this.logger.log(`[DNS] Resolving ${hostname} via Cloudflare/Google DoH...`);
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
                this.logger.log(`[DNS] Resolved ${hostname} to ${ip}`);
                this.ipCache[hostname] = ip;
                return ip;
            }
        } catch {
            // Silence DNS errors
        }

        const fallbackIp = this.fallbackApiIps[hostname];
        if (fallbackIp) {
            this.logger.warn(`[DNS] Falling back to temporary pinned IP for ${hostname}: ${fallbackIp}`);
            return fallbackIp;
        }

        return null;
    }
}
