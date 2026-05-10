import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { TradeService } from '../trade/trade.service';
import { AnalyzerService } from '../analyzer/analyzer.service';
import * as WebSocket from 'ws';
import axios from 'axios';

const RAYDIUM_PROGRAM_ID = new PublicKey('675kRwJGm1MqJCYR6ba8Lde6ygvwtq22U6cC1Fi991S8');

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

        this.startScanner();
        this.startPumpFunScanner();
        this.startPollingDexScreener();
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

    private startScanner() {
        this.logger.log(`Starting Raydium WSS scanner...`);
        try {
            this.subscriptionId = this.connection.onProgramAccountChange(
                RAYDIUM_PROGRAM_ID,
                (updatedAccountInfo) => {
                    const data = updatedAccountInfo.accountInfo.data;
                    if (data.length === 752) {
                        const baseMint = new PublicKey(data.slice(400, 432)).toBase58();
                        const quoteMint = new PublicKey(data.slice(432, 464)).toBase58();
                        const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
                        const tokenMint = baseMint === WRAPPED_SOL ? quoteMint : baseMint;

                        if (!this.seenTokens.has(tokenMint)) {
                            this.seenTokens.add(tokenMint);
                            this.logger.log(`⚡ [Raydium] New Pool Detected: ${tokenMint}`);
                            this.processNewToken(tokenMint);
                        }
                    }
                },
                'confirmed',
                [{ dataSize: 752 }],
            );
        } catch (error) {
            this.logger.error(`Failed to start Raydium scanner: ${error.message}`);
        }
    }

    private startPumpFunScanner() {
        this.logger.log('Starting Pump.fun Sniper (via PumpPortal)...');
        try {
            this.pumpFunWs = new WebSocket('wss://pumpportal.fun/api/data');

            this.pumpFunWs.on('open', () => {
                this.pumpFunWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
                this.logger.log('Connected to Pump.fun WebSocket');
            });

            this.pumpFunWs.on('message', (data) => {
                const message = JSON.parse(data.toString());
                if (message.mint) {
                    const tokenMint = message.mint;
                    if (!this.seenTokens.has(tokenMint)) {
                        this.seenTokens.add(tokenMint);
                        this.logger.log(`🔥 [Pump.fun] New Token Born: ${tokenMint}`);
                        this.processNewToken(tokenMint);
                    }
                }
            });

            this.pumpFunWs.on('error', (err) =>
                this.logger.error(`Pump.fun WS Error: ${err.message}`),
            );
            this.pumpFunWs.on('close', () => {
                this.logger.warn('Pump.fun WS closed. Reconnecting in 5s...');
                setTimeout(() => this.startPumpFunScanner(), 5000);
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to start Pump.fun scanner: ${message}`);
        }
    }

    private startPollingDexScreener() {
        this.logger.log('Starting DexScreener API fallback polling...');
        setInterval(async () => {
            try {
                const response = await axios.get(
                    'https://api.dexscreener.com/token-profiles/latest/v1',
                    { timeout: 10000 },
                );
                const solTokens = (
                    response.data as Array<{ chainId: string; tokenAddress: string }>
                ).filter((t) => t.chainId === 'solana');
                for (const token of solTokens) {
                    const mint = token.tokenAddress;
                    if (!this.seenTokens.has(mint)) {
                        this.seenTokens.add(mint);
                        this.logger.log(`🔍 [DexScreener] New Token Profile: ${mint}`);
                        this.processNewToken(mint);
                    }
                }
        } catch {
            // Polling fails silently or with log
        }
        }, 20000);
    }

    private async processNewToken(tokenMint: string) {
        await new Promise((res) => setTimeout(res, Math.random() * 2000));

        try {
            const isSafe = await this.analyzerService.isTokenSafeToBuy(tokenMint);
            if (isSafe) {
                await this.tradeService.attemptBuy(tokenMint);
            } else {
                this.logger.log(`[${tokenMint}] Skipped: Failed safety checks.`);
            }
        } catch (error) {
            this.logger.error(`Error processing token ${tokenMint}: ${error.message}`);
        }
    }
}
