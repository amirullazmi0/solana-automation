import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import axios from 'axios';
import * as https from 'https';
import { DexScreenerPair, TokenMetadata } from './analyzer.service';
import { TradeService } from '../trade/trade.service';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { DexLimiter } from '../common/dex-limiter';
import { CreatorProfileService } from './creator-profile.service';

export interface ReboundResult {
    isEstablished: boolean;
    executed: boolean;
    reason?: string;
}

interface RugCheckMarket {
    lpType: string;
    lpStatus: string;
}

interface RugCheckHolder {
    address: string;
    amount: number;
    pct: number;
    owner: string;
}

interface RugCheckKnownAccount {
    name: string;
    type: string;
}

@Injectable()
export class EstablishedAnalyzerService {
    private readonly logger = new Logger(EstablishedAnalyzerService.name);
    private readonly connection: Connection;
    private readonly ipCache: Record<string, string> = {};

    constructor(
        private readonly configService: ConfigService,
        private readonly moduleRef: ModuleRef,
        private readonly prismaService: PrismaService,
        private readonly creatorProfileService: CreatorProfileService,
    ) {
        const rpcEndpoint =
            this.configService.get<string>('RPC_ENDPOINT') || 'https://api.mainnet-beta.solana.com';
        this.connection = new Connection(rpcEndpoint, 'confirmed');
    }

    private get tradeService(): TradeService {
        return this.moduleRef.get(TradeService, { strict: false });
    }

    private getHttpsAgent() {
        return new https.Agent({
            family: 4,
            keepAlive: true,
            lookup: async (hostname, options, cb) => {
                try {
                    const ip = await this.resolveDns(hostname);
                    if (ip) {
                        cb(null, ip, 4);
                    } else {
                        import('dns')
                            .then(({ lookup }) => {
                                lookup(hostname, options, cb);
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

    private async resolveDns(hostname: string): Promise<string> {
        if (this.ipCache[hostname]) return this.ipCache[hostname];
        try {
            let response = await axios
                .get(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
                    headers: { accept: 'application/dns-json' },
                    timeout: 5000,
                    httpsAgent: this.getHttpsAgent(),
                })
                .catch(() => null);

            if (!response) {
                response = await axios
                    .get(`https://8.8.8.8/resolve?name=${hostname}&type=A`, {
                        timeout: 5000,
                        httpsAgent: this.getHttpsAgent(),
                    })
                    .catch(() => null);
            }

            const ip = response?.data?.Answer?.[0]?.data;
            if (ip && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
                this.ipCache[hostname] = ip;
                return ip;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${hostname}] DNS resolution failed: ${msg}`);
        }
        return hostname;
    }

    /**
     * Memeriksa keamanan on-chain (Anti-Rug Guard)
     */
    private async checkOnChainAuthority(tokenMint: string, isPumpFun: boolean): Promise<boolean> {
        const mintPublicKey = new PublicKey(tokenMint);
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const accountInfo = await this.connection.getAccountInfo(mintPublicKey);
                if (!accountInfo) {
                    throw new Error('Mint account not found on-chain');
                }
                const mintInfo = await getMint(
                    this.connection,
                    mintPublicKey,
                    undefined,
                    accountInfo.owner,
                );

                // mintAuthority HARUS null (Renounced / Kunci dibuang)
                if (mintInfo.mintAuthority !== null) {
                    this.logger.warn(`[${tokenMint}] 🛑 Mint authority still active. Reject.`);
                    return false;
                }

                // freezeAuthority HARUS null (Disabled)
                if (mintInfo.freezeAuthority !== null) {
                    if (isPumpFun) {
                        this.logger.debug(
                            `[${tokenMint}] ⚠️ Freeze authority active but PumpFun token — TOLERATED.`,
                        );
                        return true;
                    }
                    this.logger.warn(
                        `[${tokenMint}] 🛑 Freeze authority active (non-PumpFun). Reject.`,
                    );
                    return false;
                }

                return true;
            } catch (e) {
                const errName = e instanceof Error ? e.name || e.message : String(e);
                this.logger.warn(
                    `[${tokenMint}] Mint authority check failed (attempt ${attempt}/${maxRetries}): ${errName}`,
                );
                if (attempt < maxRetries) {
                    await new Promise((res) => setTimeout(res, 1000 * attempt));
                }
            }
        }
        return false;
    }

    /**
     * Memeriksa status keamanan token via RugCheck API secara menyeluruh
     */
    private async checkRugCheckLP(
        tokenMint: string,
        isPumpFun: boolean,
    ): Promise<{
        passed: boolean;
        creator?: string;
        topHolder?: string;
        reason?: string;
        isCTO?: boolean;
    }> {
        try {
            const response = await axios.get(
                `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`,
                {
                    timeout: 5000,
                    httpsAgent: this.getHttpsAgent(),
                },
            );

            if (!response.data) return { passed: false, reason: 'no_rugcheck_data' };

            const topHolders = (response.data.topHolders as RugCheckHolder[]) || [];
            const knownAccounts =
                (response.data.knownAccounts as Record<string, RugCheckKnownAccount | undefined>) ||
                {};

            // 🛡️ SAFETY & HOLDER INDEX (Anti-Rug)
            const filteredHolders = topHolders.filter((h) => {
                const known = knownAccounts[h.address] || knownAccounts[h.owner];
                const isExcludedType = known && (known.type === 'AMM' || known.type === 'LOCKER');
                const isSystemAccount = h.owner === '1111111111111111111111111111111';
                return !isExcludedType && !isSystemAccount;
            });

            // 🧑‍💻 CREATOR BALANCE CHECK (Anti-Dump)
            const creator = response.data.creator;
            let creatorPct = 0;
            if (creator) {
                // Gunakan RPC langsung alih-alih data topHolders RugCheck yang tidak lengkap
                creatorPct = await this.getCreatorBalancePercent(creator, tokenMint);
            }
            const isCTO = creator ? creatorPct < 0.1 : false;

            const top10SumPct = filteredHolders
                .slice(0, 10)
                .reduce((sum: number, h: RugCheckHolder) => sum + (h.pct || 0), 0);
            const safetyIndex = 1 - top10SumPct / 100;

            const defaultSafetyIndex = isCTO ? '0.20' : '0.65';
            const minSafetyIndex = Number.parseFloat(
                this.configService.get<string>('RUGCHECK_MIN_SAFETY_INDEX', defaultSafetyIndex),
            );
            if (safetyIndex < minSafetyIndex) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 Established High Concentration: Top 10 holds ${(1 - safetyIndex) * 100}%. Reject. (isCTO: ${isCTO})`,
                );
                return { passed: false, reason: 'established_high_concentration', isCTO };
            }

            const markets = (response.data.markets as RugCheckMarket[]) || [];
            const lpSafe = markets.some(
                (m: RugCheckMarket) =>
                    m.lpType === 'burned' ||
                    m.lpStatus === 'burned' ||
                    m.lpType === 'locked' ||
                    m.lpStatus === 'locked',
            );

            if (!lpSafe && markets.length > 0 && !isPumpFun) {
                this.logger.warn(`[${tokenMint}] 🛑 LP is NOT burned or locked. Reject.`);
                return { passed: false, reason: 'lp_not_burned_or_locked', isCTO };
            }

            const score = response.data.score || 0;
            if (score > 1000) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 Established High Risk Score: ${score}. Reject.`,
                );
                return { passed: false, reason: 'established_high_risk_score', isCTO };
            }

            const risks = (response.data.risks as Array<{ name: string; level: string }>) || [];
            const hasHoneypotRisk = risks.some(
                (r) =>
                    r.name.toLowerCase().includes('honeypot') ||
                    r.name.toLowerCase().includes('freeze') ||
                    r.name.toLowerCase().includes('mint authority'),
            );

            if (hasHoneypotRisk) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 Established HONEYPOT/FREEZE/MINT RISK detected. Reject.`,
                );
                return { passed: false, reason: 'established_honeypot_detected', isCTO };
            }

            const highRisks = risks.filter((risk) => risk.level === 'danger');
            if (highRisks.length > 0) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 Established Danger risk detected (${highRisks.map((r) => r.name).join(', ')}). Reject.`,
                );
                return { passed: false, reason: 'established_danger_risks_detected', isCTO };
            }

            if (creator && !isCTO) {
                if (creatorPct > 5) {
                    this.logger.warn(
                        `[${tokenMint}] 🛑 Established Creator holds too much (${creatorPct.toFixed(2)}%). Reject.`,
                    );
                    return { passed: false, reason: 'established_creator_holds_too_much', isCTO };
                }
            }

            return {
                passed: true,
                creator: response.data.creator,
                topHolder: topHolders[0]?.address,
                isCTO,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] RugCheck API Error: ${msg}`);
            return { passed: false, reason: `rugcheck_api_error: ${msg}` };
        }
    }

    private async getCreatorBalancePercent(
        creatorAddress: string,
        tokenMint: string,
    ): Promise<number> {
        try {
            const { PublicKey } = await import('@solana/web3.js');
            const creatorKey = new PublicKey(creatorAddress);
            const mintKey = new PublicKey(tokenMint);

            const accounts = await this.connection.getParsedTokenAccountsByOwner(creatorKey, {
                mint: mintKey,
            });
            let creatorBalance = 0;
            if (accounts.value.length > 0) {
                creatorBalance =
                    accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
            }

            const accountInfo = await this.connection.getAccountInfo(mintKey);
            if (!accountInfo) return 0;
            const { getMint } = await import('@solana/spl-token');
            const mintInfo = await getMint(this.connection, mintKey, undefined, accountInfo.owner);
            const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);

            if (totalSupply <= 0) return 0;
            return (creatorBalance / totalSupply) * 100;
        } catch (error) {
            this.logger.error(
                `Failed to get creator balance percent: ${error instanceof Error ? error.message : String(error)}`,
            );
            return 0;
        }
    }

    /**
     * Rumus Divergensi Volume-Harga (Trigger Rebound)
     */
    public checkVolumePriceDivergence(pairData: DexScreenerPair): boolean {
        const volumeSpikeRatio = Number.parseFloat(
            this.configService.get<string>('VOLUME_SPIKE_RATIO', '0.25'),
        );
        const reboundPriceDropPct = Number.parseFloat(
            this.configService.get<string>('REBOUND_PRICE_DROP_PCT', '-50'),
        );

        const volume5m = pairData.volume?.m5 || 0;
        const volume1h = pairData.volume?.h1 || 0;
        const priceChange5m = pairData.priceChange?.m5 || 0;
        const priceChange24h = pairData.priceChange?.h24 ?? (pairData.priceChange?.h6 || 0); // Fallback ke h6 jika h24 kosong

        // 1. Kondisi Volume Spike: V_5m > V_1h * VOLUME_SPIKE_RATIO
        const isVolumeSpiking = volume5m > volume1h * volumeSpikeRatio && volume5m > 500; // Minimal ada volume $500 di 5m

        // 2. Kondisi Lantai Konsolidasi (Flat 5m): Pergerakan harga 5m relatif datar (membentuk support/lantai)
        // Harga tidak boleh lanjut terjun bebas di 5m (harus >= -2%) dan belum terbang jauh (<= +5%)
        const isConsolidating = priceChange5m >= -2.0 && priceChange5m <= 5.0;

        // 3. Kondisi Deep Sell-off (24h drop <= REBOUND_PRICE_DROP_PCT)
        const isDeepSelloff = priceChange24h <= reboundPriceDropPct;

        return isVolumeSpiking && isConsolidating && isDeepSelloff;
    }

    /**
     * Pengecekan Dominasi Pembeli (Buyer Dominance)
     */
    public checkBuyerDominance(pairData: DexScreenerPair): boolean {
        const buySellRatioThreshold = Number.parseFloat(
            this.configService.get<string>('BUY_SELL_RATIO_THRESHOLD', '1.5'),
        );
        const minBuys = Number.parseInt(
            this.configService.get<string>('ESTABLISHED_MIN_BUYS', '5'),
            10,
        );

        const buys = pairData.txns?.m5?.buys || 0;
        const sells = pairData.txns?.m5?.sells || 0;

        // Kondisi: buys > (sells * buySellRatioThreshold) AND buys >= minBuys
        return buys > sells * buySellRatioThreshold && buys >= minBuys;
    }

    /**
     * Endpoint Analisis Utama untuk Token Kandidat
     */
    public async analyzeAndExecuteRebound(tokenMint: string): Promise<ReboundResult> {
        try {
            // 1. Fetch data dari DexScreener
            const response = await DexLimiter.get<{ pairs: DexScreenerPair[] }>(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                { timeout: 5000, httpsAgent: this.getHttpsAgent() },
            );

            const pair = response.data?.pairs?.[0];
            if (!pair) {
                return { isEstablished: false, executed: false, reason: 'no_dex_pair' };
            }

            const minAgeHours = Number.parseFloat(
                this.configService.get<string>('ESTABLISHED_MIN_AGE_HOURS') ??
                    this.configService.get<string>('MIN_AGE_HOURS', '24'),
            );
            const maxAgeHours = Number.parseFloat(
                this.configService.get<string>('ESTABLISHED_MAX_AGE_HOURS') ??
                    this.configService.get<string>('MAX_AGE_HOURS', '72'),
            );
            const minLiqUsd = Number.parseFloat(
                this.configService.get<string>('MIN_ESTABLISHED_LIQUIDITY', '3000'),
            );
            const maxMcapUsd = Number.parseFloat(
                this.configService.get<string>('MAX_ESTABLISHED_MCAP', '200000'),
            );

            const ageHours = (Date.now() - (pair.pairCreatedAt || 0)) / (1000 * 60 * 60);
            const liquidity = pair.liquidity?.usd || 0;
            const marketCap = pair.fdv || 0;
            const symbol = pair.baseToken?.symbol || 'UNKNOWN';

            // Filter Umur & Likuiditas Mapan
            if (ageHours < minAgeHours) {
                return { isEstablished: false, executed: false, reason: 'too_young_for_rebound' };
            }
            if (ageHours > maxAgeHours) {
                return { isEstablished: true, executed: false, reason: 'too_old_for_rebound' };
            }
            if (liquidity < minLiqUsd) {
                return {
                    isEstablished: true,
                    executed: false,
                    reason: 'low_established_liquidity',
                };
            }
            if (marketCap > maxMcapUsd) {
                return {
                    isEstablished: true,
                    executed: false,
                    reason: 'mcap_too_high_for_established',
                };
            }

            // 2. Periksa Rumus Divergensi Volume-Harga
            if (!this.checkVolumePriceDivergence(pair)) {
                return { isEstablished: true, executed: false, reason: 'rebound_not_triggered' };
            }

            // 3. Periksa Dominasi Pembeli
            if (!this.checkBuyerDominance(pair)) {
                return { isEstablished: true, executed: false, reason: 'low_buyer_dominance' };
            }

            // 4. Periksa Keamanan On-Chain (Authority)
            const isPumpFunToken =
                tokenMint.toLowerCase().endsWith('pump') ||
                pair.info?.websites?.some((w) => w.url.includes('pump.fun')) ||
                false;
            const isAuthoritySafe = await this.checkOnChainAuthority(tokenMint, isPumpFunToken);
            if (!isAuthoritySafe) {
                return {
                    isEstablished: true,
                    executed: false,
                    reason: 'established_security_authority_failed',
                };
            }

            // 5. Periksa Status LP RugCheck
            const rugResult = await this.checkRugCheckLP(tokenMint, isPumpFunToken);
            if (!rugResult.passed) {
                return {
                    isEstablished: true,
                    executed: false,
                    reason: `established_rugcheck_failed_${rugResult.reason}`,
                };
            }

            // 🧑‍💻 CREATOR PROFILE CHECK (Anti-Rug)
            if (rugResult.creator) {
                const profile = await this.creatorProfileService.evaluateCreator(rugResult.creator);
                
                if (profile.isBlacklisted || profile.riskScore >= 80) {
                    this.logger.warn(
                        `[${tokenMint}] 🛑 Established Creator ${rugResult.creator} is blacklisted or high risk (Score: ${profile.riskScore}). Skip.`,
                    );
                    return {
                        isEstablished: true,
                        executed: false,
                        reason: 'established_creator_high_risk',
                    };
                }
            }

            // 🚀 SEMUA FILTER LOLOS - SIAP EKSEKUSI
            this.logger.log(
                `📈 CONFIRMED REBOUND SIGNALS for $${symbol} (${tokenMint})! Ready to strike. (isCTO: ${rugResult.isCTO})`,
            );

            const metadata: TokenMetadata = {
                liquidity,
                marketCap,
                mcap: marketCap,
                pairCreatedAt: pair.pairCreatedAt,
                symbol: `$${symbol}`,
                socials: {
                    twitter: pair.info?.socials?.find((s) => s.type === 'twitter')?.url,
                    telegram: pair.info?.socials?.find((s) => s.type === 'telegram')?.url,
                    website: pair.info?.websites?.[0]?.url,
                },
                creator: rugResult.creator,
                topHolder: rugResult.topHolder,
                isPumpFun: isPumpFunToken,
                isCTO: rugResult.isCTO,
            };

            // Eksekusi Swap Jupiter V6 dengan Pengaturan Keluar Ketat
            const buyResult = await this.tradeService.attemptBuy(tokenMint, metadata, undefined, {
                customSlippageBps: 300, // Slippage 3%
                priorityFeeSol: 0.0001, // 0.0001 SOL Jito tip / Priority fee
                targetTakeProfit: 18.0, // TP 18% (antara 15% - 20%)
                targetTrailingDistance: 2.5, // Trailing stop 2.5% (antara 2% - 3%)
                targetStopLoss: 20.0, // Hard stop loss 20%
            });

            return {
                isEstablished: true,
                executed: buyResult.success,
                reason: buyResult.success ? undefined : buyResult.message,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] Rebound analysis failed: ${msg}`);
            return {
                isEstablished: true,
                executed: false,
                reason: `rebound_analysis_error: ${msg}`,
            };
        }
    }
}
