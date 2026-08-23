import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import axios from 'axios';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { DexLimiter } from '../common/dex-limiter';
import { JupiterLimiter } from '../common/jupiter-limiter';
import { CreatorProfileService } from './creator-profile.service';
import { AIService } from '../ai/ai.service';
import {
    CreatorOwnershipResult,
    DexScreenerPair,
    RugCheckApiHolder,
    RugCheckApiResponse,
    RugCheckHolder,
    RugCheckMarket,
    RugCheckResponse,
    RugCheckRisk,
    TokenMetadata,
} from '../dto/analyzer.dto';

export { selectBestDexScreenerPair } from '../common/dex-pair';
import { selectBestDexScreenerPair } from '../common/dex-pair';
import { buyShare, failsBuyShare, formatBuyShare } from '../common/flow-pressure';
import { averageVolume5m } from '../common/volume-baseline';
import { FlowVolumeService } from './flow-volume.service';
import { shouldRejectOnNarrative } from '../ai/narrative-advice';
import { NarrativeService } from './narrative.service';
import { evaluateMintSafety } from '../common/token-mint-safety';
import { DEFAULT_MIN_LP_LOCKED_PCT, isLpSafe, isMarketLpSafe, maxLpLockedPct } from '../common/lp-safety';
import {
    DEFAULT_HOLDER_DATA_SETTLE_MINUTES,
    DEFAULT_MAX_NORMALISED_RISK_SCORE,
    exceedsRiskScore,
    isHolderDataSettled,
    resolveNormalisedRiskScore,
    selectBlockingDangerRisks,
} from '../common/rugcheck-risk';

export type BearishReboundConfig = {
    hardFloorPct: number;
    minRebound5mPct: number;
};

export function evaluateBearishRebound(
    priceChange1hPct: number,
    priceChange5mPct: number,
    config: BearishReboundConfig,
): { allowed: boolean; permanent: boolean } {
    if (priceChange1hPct >= -15) return { allowed: true, permanent: false };
    if (priceChange1hPct < config.hardFloorPct) return { allowed: false, permanent: true };
    return { allowed: priceChange5mPct >= config.minRebound5mPct, permanent: false };
}

@Injectable()
export class AnalyzerService {
    private readonly logger = new Logger(AnalyzerService.name);
    private readonly connection: Connection;
    private readonly jupiterApiKey: string;
    private readonly ipCache: Record<string, string> = {};
    private creatorRpcFailureCount = 0;

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
        private readonly creatorProfileService: CreatorProfileService,
        private readonly aiService: AIService,
        private readonly flowVolumeService: FlowVolumeService,
        private readonly narrativeService: NarrativeService,
    ) {
        this.connection = new Connection(this.getSolanaRpcUrl(), 'confirmed');
        this.jupiterApiKey = this.configService.get<string>('JUPITER_API_KEY') || '';
    }

    private getSolanaRpcUrl(): string {
        const heliusRpcUrl = this.configService.get<string>('SOLANA_RPC_URL');
        if (heliusRpcUrl && heliusRpcUrl.trim()) {
            return heliusRpcUrl.trim();
        }

        const fallbackRpcUrl = this.configService.get<string>('RPC_ENDPOINT');
        if (fallbackRpcUrl && fallbackRpcUrl.trim()) {
            return fallbackRpcUrl.trim();
        }

        return 'https://api.mainnet-beta.solana.com';
    }

    /**
     * A rolling window of what this bot has actually seen trading, used as meta context.
     *
     * The first version fed the model DexScreener's boost feed. That feed is PAID promotion, so
     * labelling it "what is hot right now" biased every verdict toward whatever spammers were
     * currently buying. This stream is organic: these are tokens the analyzer just measured, with
     * their real five-minute volume, and it costs no extra request because the data already passes
     * through checkMarketTraction on every cycle.
     */
    private readonly recentlySeen = new Map<string, { name: string; volume5m: number; at: number }>();

    private recordSeenToken(name: string | undefined, volume5m: number): void {
        const label = String(name ?? '').trim();
        if (!label || !Number.isFinite(volume5m) || volume5m <= 0) return;

        this.recentlySeen.set(label.toLowerCase(), { name: label, volume5m, at: Date.now() });

        // Bounded by age, then by size, so a quiet period cannot leave stale names in the context.
        const cutoff = Date.now() - 30 * 60 * 1000;
        for (const [key, entry] of this.recentlySeen.entries()) {
            if (entry.at < cutoff) this.recentlySeen.delete(key);
        }
        if (this.recentlySeen.size > 200) {
            const oldest = [...this.recentlySeen.entries()].sort((a, b) => a[1].at - b[1].at);
            for (const [key] of oldest.slice(0, this.recentlySeen.size - 200)) {
                this.recentlySeen.delete(key);
            }
        }
    }

    /** The busiest names seen recently — the model's evidence for what is actually being traded. */
    private get trendingDescriptions(): string[] {
        return [...this.recentlySeen.values()]
            .sort((a, b) => b.volume5m - a.volume5m)
            .slice(0, 25)
            .map((e) => `${e.name} (vol5m $${Math.round(e.volume5m)})`);
    }

    private isMetaNarrativeMatch(tokenName?: string): { matched: boolean; label?: string } {
        const normalized = (tokenName || '').toLowerCase();
        if (!normalized) return { matched: false };

        const patterns: Array<{ label: string; regex: RegExp }> = [
            { label: 'AI', regex: /\b(ai|agent|llm|gpt|model)\b/i },
            { label: 'Dog', regex: /\b(dog|doge|inu|shib)\b/i },
            { label: 'Cat', regex: /\b(cat|kitty|neko)\b/i },
            { label: 'Politics', regex: /\b(trump|polit|election|biden|maga|president)\b/i },
            { label: 'Meme', regex: /\b(meme|pepe|frog|wojak)\b/i },
            { label: 'Solana', regex: /\b(sol|solana|jito|pump|raydium)\b/i },
            { label: 'Celebrity', regex: /\b(elon|musk|x\s?ai|tate|kanye)\b/i },
        ];

        for (const pattern of patterns) {
            if (pattern.regex.test(normalized)) {
                return { matched: true, label: pattern.label };
            }
        }

        return { matched: false };
    }

    private calculateWhaleSignalScore(input: {
        ageHours: number;
        hasWebsite: boolean;
        hasTwitter: boolean;
        hasTelegram: boolean;
        isCommunityTakeover?: boolean;
        tokenName?: string;
        volumeSurge?: number;
        volScore?: number;
        zScore?: number;
        priceChange1hPct?: number;
        priceChange5mPct?: number;
        priceChange15mPct?: number;
        creatorRiskScore?: number;
        creatorRuggedTokens?: number;
        safetyIndex?: number;
        liquidityUsd: number;
        marketCapUsd: number;
    }): { score: number; reasons: string[]; narrativeLabel?: string } {
        let score = 30;
        const reasons: string[] = [];

        const ageHours = Math.max(input.ageHours || 0, 0);
        if (ageHours >= 4) {
            score += 8;
            reasons.push('age>=4h');
        }
        if (ageHours >= 12) {
            score += 4;
            reasons.push('age>=12h');
        }

        if (input.hasTwitter) {
            score += 14;
            reasons.push('twitter');
        }
        if (input.hasTelegram) {
            score += 14;
            reasons.push('telegram');
        }
        if (input.hasWebsite) {
            score += 6;
            reasons.push('website');
        }
        if (input.hasTwitter && input.hasTelegram) {
            score += 10;
            reasons.push('social-duo');
        }
        if (!input.hasTwitter && !input.hasTelegram) {
            score -= ageHours >= 4 ? 20 : 14;
            reasons.push('social-empty');
        } else if (!input.hasTwitter || !input.hasTelegram) {
            score -= 4;
            reasons.push('single-social');
        }

        if (input.isCommunityTakeover) {
            score += 12;
            reasons.push('cto');
        }

        const narrative = this.isMetaNarrativeMatch(input.tokenName);
        if (narrative.matched) {
            score += 8;
            reasons.push(`narrative:${narrative.label}`);
        }

        const volumeSurge = input.volumeSurge ?? 0;
        if (volumeSurge >= 3) {
            score += 12;
            reasons.push('volume-surge>=3x');
        } else if (volumeSurge >= 2) {
            score += 8;
            reasons.push('volume-surge>=2x');
        } else if (volumeSurge >= 1.5) {
            score += 4;
            reasons.push('volume-surge>=1.5x');
        }

        const volScore = input.volScore ?? 0;
        if (volScore >= 0.9) {
            score += 8;
            reasons.push('vol-score>=0.9');
        } else if (volScore >= 0.5) {
            score += 4;
            reasons.push('vol-score>=0.5');
        }

        const priceChange1hPct = input.priceChange1hPct ?? 0;
        const priceChange5mPct = input.priceChange5mPct ?? 0;
        const priceChange15mPct = input.priceChange15mPct ?? 0;
        const momentumAligned =
            priceChange1hPct > 0 && priceChange5mPct > 0 && priceChange15mPct > 0;
        if (momentumAligned) {
            score += 4;
            reasons.push('momentum-aligned');
        }

        if (input.safetyIndex !== undefined) {
            if (input.safetyIndex >= 0.8) {
                score += 6;
                reasons.push('safety>=0.8');
            } else if (input.safetyIndex >= 0.65) {
                score += 3;
                reasons.push('safety>=0.65');
            } else {
                score -= 10;
                reasons.push('safety-low');
            }
        }

        const creatorRiskScore = input.creatorRiskScore ?? 0;
        if (creatorRiskScore >= 80) {
            score -= 24;
            reasons.push('creator-risk>=80');
        } else if (creatorRiskScore >= 60) {
            score -= 14;
            reasons.push('creator-risk>=60');
        }

        const creatorRuggedTokens = input.creatorRuggedTokens ?? 0;
        if (creatorRuggedTokens >= 3) {
            score -= 18;
            reasons.push('creator-rugs>=3');
        } else if (creatorRuggedTokens >= 1) {
            score -= 10;
            reasons.push('creator-rugs>=1');
        }

        if (input.marketCapUsd >= 150_000 && input.marketCapUsd <= 3_000_000) {
            score += 4;
            reasons.push('mcap-whale-band');
        }
        if (input.liquidityUsd >= 5_000) {
            score += 4;
            reasons.push('liquidity-ok');
        }

        score = Math.max(-100, Math.min(100, Math.round(score)));
        return { score, reasons, narrativeLabel: narrative.label };
    }

    private resolveRoute(ageHours: number): 'MICIN_ROUTE' | 'WHALE_ROUTE' {
        return ageHours < 2 ? 'MICIN_ROUTE' : 'WHALE_ROUTE';
    }

    private calculateMicinNoiseRisk(input: {
        volumeSurge?: number;
        volScore?: number;
        zScore?: number;
        priceChange1hPct?: number;
        priceChange5mPct?: number;
        priceChange15mPct?: number;
        buys5mCount?: number;
        sells5mCount?: number;
    }): { severity: number; reasons: string[]; isFakePump: boolean } {
        let severity = 0;
        const reasons: string[] = [];

        const volumeSurge = input.volumeSurge ?? 0;
        const volScore = input.volScore ?? 0;
        const zScore = input.zScore ?? 0;
        const priceChange1hPct = input.priceChange1hPct ?? 0;
        const priceChange5mPct = input.priceChange5mPct ?? 0;
        const priceChange15mPct = input.priceChange15mPct ?? 0;
        const buys5mCount = input.buys5mCount ?? 0;
        const sells5mCount = input.sells5mCount ?? 0;

        const verticalFiveMinPump =
            priceChange5mPct >= 25 && priceChange5mPct >= Math.max(priceChange15mPct, 1) * 3;
        if (verticalFiveMinPump) {
            severity += 30;
            reasons.push('vertical-5m');
        }

        const weakVolumeSupport = volumeSurge >= 2.5 && volScore < 0.35;
        if (weakVolumeSupport) {
            severity += 25;
            reasons.push('weak-vol-support');
        }

        const weakAnomalySupport = volumeSurge >= 2 && zScore < 1.25;
        if (weakAnomalySupport) {
            severity += 20;
            reasons.push('weak-z-support');
        }

        const sellPressure = sells5mCount > buys5mCount * 1.1 && sells5mCount >= 5;
        if (sellPressure) {
            severity += 20;
            reasons.push('sell-pressure');
        }

        if (priceChange1hPct <= 0 && priceChange5mPct >= 15) {
            severity += 10;
            reasons.push('1h-bearish-5m-pump');
        }

        if (buys5mCount === 0 && sells5mCount > 0 && volumeSurge >= 2) {
            severity += 15;
            reasons.push('no-buy-support');
        }

        severity = Math.max(0, Math.min(100, Math.round(severity)));
        return { severity, reasons, isFakePump: severity >= 70 };
    }

    /**
     * Safety filter to check if token is safe and trending.
     */
    async isTokenSafeToBuy(
        tokenMint: string,
    ): Promise<{ safe: boolean; metadata?: TokenMetadata; reason?: string; permanent?: boolean }> {
        try {
            // 1. DEXSCREENER (Traction & Metrics)
            const traction = await this.checkMarketTraction(tokenMint);

            const baseMetadata: TokenMetadata = {
                liquidity: traction.liquidity || 0,
                pairAddress: traction.pairAddress,
                marketCap: traction.marketCap || 0,
                mcap: traction.marketCap,
                pairCreatedAt: traction.pairCreatedAt,
                awaitingAmmPair: traction.awaitingAmmPair,
                symbol: traction.symbol,
                tokenName: traction.tokenName,
                socials: traction.socials,
                volumeSurge: traction.volumeSurge,
                volScore: traction.volScore,
                zScore: traction.zScore,
                priceChange1h: traction.priceChange1h,
                priceChange5m: traction.priceChange5m,
                priceUsd: traction.priceUsd,
                buys5m: traction.buys5m,
                sells5m: traction.sells5m,
                isPumpFun: traction.isPumpFun,
                hasWebsite: Boolean(traction.socials?.website?.trim()),
                hasTwitter: Boolean(traction.socials?.twitter?.trim()),
                hasTelegram: Boolean(traction.socials?.telegram?.trim()),
                isDexPaidUpdated: Boolean(
                    traction.socials?.website?.trim() ||
                    traction.socials?.twitter?.trim() ||
                    traction.socials?.telegram?.trim(),
                ),
            };

            if (!traction.passed) {
                return {
                    safe: false,
                    reason: traction.reason || 'low_traction',
                    permanent: traction.permanent,
                    metadata: baseMetadata,
                };
            }

            // Warm the narrative verdict here rather than at the buy decision. Everything below —
            // RugCheck, creator profile, whale scoring — is seconds of network I/O this call is
            // already paying for, so the model answers inside a window that already exists. If it
            // has not answered by the time the decision is reached, the candidate simply proceeds
            // without an opinion.
            this.narrativeService.scheduleEvaluation(
                tokenMint,
                {
                    tokenName: traction.tokenName || traction.symbol || tokenMint,
                    symbol: traction.symbol || 'UNKNOWN',
                    deterministicLabel: this.isMetaNarrativeMatch(traction.tokenName).label,
                    twitterUrl: traction.socials?.twitter,
                    telegramUrl: traction.socials?.telegram,
                    websiteUrl: traction.socials?.website,
                    ageMinutes: traction.pairCreatedAt
                        ? (Date.now() - traction.pairCreatedAt) / 60000
                        : 0,
                    marketCapUsd: traction.marketCap || 0,
                    trendingDescriptions: this.trendingDescriptions,
                },
                this.isMetaNarrativeMatch(traction.tokenName).label,
            );

            // 🛡️ ADVANCED METRICS CHECK
            // 1. VoL Check (Min 0.05 untuk koin breakout)
            const minVolScore = Number.parseFloat(
                this.configService.get<string>('ANALYZER_MIN_VOL_SCORE', '0.05'),
            );
            if (traction.volScore && traction.volScore < minVolScore) {
                this.logger.debug(
                    `[${tokenMint}] Low VoL Score: ${traction.volScore.toFixed(4)}. Supply not shocked enough.`,
                );
                return { safe: false, reason: 'low_vol_score', metadata: baseMetadata };
            }

            const blockedProbe = await this.prismaService.tokenSafetyProbe.findFirst({
                where: { tokenMint, verdict: 'BLOCKED' },
                select: { reason: true },
            });
            if (blockedProbe) {
                return {
                    safe: false,
                    reason: blockedProbe.reason || 'honeypot_probe_blocked',
                    permanent: true,
                    metadata: baseMetadata,
                };
            }

            // 2. RPC CHECK (Security)
            const safetyRpc = await this.checkTokenSecurityRPC(tokenMint);
            if (!safetyRpc.passed) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 Safety RPC check FAILED (Freeze/Mint authority). Skip.`,
                );
                return {
                    safe: false,
                    reason: 'safety_rpc_failed',
                    permanent: safetyRpc.permanent,
                    metadata: baseMetadata,
                };
            }

            // 3. RUGCHECK (Advanced Safety Index & LP Burn)
            const rugResult = await this.checkRugCheckAPI(
                tokenMint,
                traction.liquidity || 0,
                traction.pairCreatedAt ? Date.now() - traction.pairCreatedAt : undefined,
            );
            if (!rugResult.passed) {
                this.logger.warn(`[${tokenMint}] 🛑 RugCheck FAILED: ${rugResult.reason}. Skip.`);
                return {
                    safe: false,
                    reason: rugResult.reason || 'rugcheck_failed',
                    permanent: rugResult.permanent,
                    metadata: baseMetadata,
                };
            }

            const openAiKey = this.configService.get<string>('OPENAI_API_KEY') || '';
            const aiEntryEnabled = ['true', '1', 'yes', 'on'].includes(
                String(this.configService.get('ENABLE_AI_ENTRY_DECISION', 'false')).toLowerCase(),
            );
            const shouldUseAi =
                aiEntryEnabled &&
                openAiKey.length > 0 &&
                !openAiKey.includes('your-openai-api-key') &&
                !openAiKey.includes('your_');
            const aiThreshold = Number.parseFloat(
                this.configService.get<string>('AI_CONVICTION_THRESHOLD', '75.0'),
            );
            // Anti-rug creator profile is needed by the whale signal score and AI payload below.
            let creatorProfile: Awaited<
                ReturnType<CreatorProfileService['evaluateCreator']>
            > | null = null;
            if (rugResult.creator) {
                creatorProfile = await this.creatorProfileService.evaluateCreator(
                    rugResult.creator,
                );

                if (creatorProfile.isBlacklisted || creatorProfile.riskScore >= 80) {
                    this.logger.warn(
                        `[${tokenMint}] Creator ${rugResult.creator} is blacklisted or high risk (Score: ${creatorProfile.riskScore}). Skip.`,
                    );
                    return {
                        safe: false,
                        reason: 'creator_high_risk',
                        permanent: true,
                        metadata: baseMetadata,
                    };
                }
            }

            const whaleSignalFloor = Number.parseFloat(
                this.configService.get<string>('WHALE_SIGNAL_SCORE_FLOOR', '45'),
            );
            const ageHours = traction.pairCreatedAt
                ? (Date.now() - traction.pairCreatedAt) / (1000 * 60 * 60)
                : 0;
            const route = this.resolveRoute(ageHours);
            const creatorExited = Boolean(rugResult.creatorExited);
            const isCommunityTakeover =
                creatorExited && Boolean(baseMetadata.hasTwitter || baseMetadata.hasTelegram);
            const whaleSignal = this.calculateWhaleSignalScore({
                ageHours,
                liquidityUsd: traction.liquidity || 0,
                marketCapUsd: traction.marketCap || 0,
                volumeSurge: traction.volumeSurge,
                volScore: traction.volScore,
                zScore: traction.zScore,
                priceChange1hPct: traction.priceChange1h || 0,
                priceChange5mPct: traction.priceChange5m || 0,
                priceChange15mPct: traction.priceChange15m || 0,
                hasWebsite: Boolean(traction.socials?.website?.trim()),
                hasTwitter: Boolean(traction.socials?.twitter?.trim()),
                hasTelegram: Boolean(traction.socials?.telegram?.trim()),
                isCommunityTakeover,
                tokenName: traction.tokenName || traction.symbol || undefined,
                creatorRiskScore: creatorProfile?.riskScore,
                creatorRuggedTokens: creatorProfile?.ruggedTokens,
                safetyIndex: rugResult.safetyIndex,
            });
            const finalMetadata: TokenMetadata = {
                ...baseMetadata,
                creator: rugResult.creator,
                topHolder: rugResult.topHolder,
                isCTO: isCommunityTakeover,
                isCommunityTakeover,
                creatorExited,
                whaleSignalScore: whaleSignal.score,
                route: route === 'WHALE_ROUTE' ? 'WHALE' : 'MICIN',
            };

            const micinNoise = this.calculateMicinNoiseRisk({
                volumeSurge: traction.volumeSurge,
                volScore: traction.volScore,
                zScore: traction.zScore,
                priceChange1hPct: traction.priceChange1h || 0,
                priceChange5mPct: traction.priceChange5m || 0,
                priceChange15mPct: traction.priceChange15m || 0,
                buys5mCount: traction.buys5m || 0,
                sells5mCount: traction.sells5m || 0,
            });
            if (route === 'MICIN_ROUTE' && micinNoise.isFakePump) {
                this.logger.warn(
                    `[${tokenMint}] [ROUTE: ${route}] Micin noise gate blocked token. Severity=${micinNoise.severity}, Reasons=${micinNoise.reasons.join(',')}.`,
                );
                return {
                    safe: false,
                    reason: 'noisy_pump',
                    permanent: false,
                    metadata: baseMetadata,
                };
            }
            const micinSignalFloor = Number.parseFloat(
                this.configService.get<string>('MICIN_SIGNAL_SCORE_FLOOR', '60'),
            );
            const micinMaxPriceChange5m = Number.parseFloat(
                this.configService.get<string>('MICIN_MAX_PRICE_CHANGE_5M', '12'),
            );
            if (route === 'MICIN_ROUTE' && (traction.priceChange5m || 0) > micinMaxPriceChange5m) {
                return {
                    safe: false,
                    reason: 'micin_price_chase',
                    permanent: false,
                    metadata: finalMetadata,
                };
            }
            // Across the 15 closed LIVE trades that carry netProfitUsd, the losers were bought
            // roughly twice as extended as the winners (avg 1h +58.1% vs +28.5%). Only the 5m
            // window was guarded, so a token that had already doubled over the hour could still
            // pass on a calm five minutes. This caps the hourly extension as well.
            const micinMaxPriceChange1h = Number.parseFloat(
                this.configService.get<string>('MICIN_MAX_PRICE_CHANGE_1H', '0'),
            );
            if (
                route === 'MICIN_ROUTE' &&
                Number.isFinite(micinMaxPriceChange1h) &&
                micinMaxPriceChange1h > 0 &&
                (traction.priceChange1h || 0) > micinMaxPriceChange1h
            ) {
                return {
                    safe: false,
                    reason: 'micin_overextended_1h',
                    permanent: false,
                    metadata: finalMetadata,
                };
            }
            if (route === 'MICIN_ROUTE' && whaleSignal.score < micinSignalFloor) {
                return {
                    safe: false,
                    reason: 'micin_signal_too_weak',
                    permanent: false,
                    metadata: finalMetadata,
                };
            }
            if (
                route === 'WHALE_ROUTE' &&
                !baseMetadata.hasTwitter &&
                !baseMetadata.hasTelegram &&
                whaleSignal.score < whaleSignalFloor
            ) {
                this.logger.warn(
                    `[${tokenMint}] [ROUTE: ${route}] Whale signal gate blocked token. Score=${whaleSignal.score}, Floor=${whaleSignalFloor}, Socials=empty.`,
                );
                return {
                    safe: false,
                    reason: 'whale_signal_too_weak',
                    permanent: false,
                    metadata: finalMetadata,
                };
            }

            // One-directional: a WEAK verdict can drop a candidate, a STRONG one changes nothing.
            // A cold verdict means the model has no opinion yet, which must not block the buy.
            const narrativeVerdict = this.narrativeService.getVerdict(tokenMint);
            const narrativeWouldReject = shouldRejectOnNarrative(narrativeVerdict, {
                // Ask what the gate WOULD decide, independently of whether it is switched on.
                enabled: true,
                maxAgeMs: this.narrativeService.maxAgeMs,
                minConfidence: this.narrativeService.minConfidence,
            });

            if (narrativeWouldReject && this.narrativeService.isEnabled) {
                this.logger.debug(
                    `[${tokenMint}] Narrative gate rejected. reason=${narrativeVerdict?.reasoning}`,
                );
                return {
                    safe: false,
                    reason: 'narrative_weak',
                    permanent: false,
                    metadata: baseMetadata,
                };
            }

            // Shadow mode: record the verdict the gate would have acted on, but let the candidate
            // through. This line is the entire output of the shadow period — it is what later gets
            // compared against how the trade actually turned out.
            if (narrativeVerdict && this.narrativeService.isShadowEnabled) {
                this.logger.log(
                    `[${tokenMint}] narrative_shadow verdict=${narrativeVerdict.verdict} ` +
                        `confidence=${narrativeVerdict.confidenceLevel} ` +
                        `wouldReject=${narrativeWouldReject} reason=${narrativeVerdict.reasoning}`,
                );
            }

            if (shouldUseAi) {
                const aiResult = await this.aiService.analyzeToken(
                    tokenMint,
                    traction.symbol || 'UNKNOWN',
                    {
                        ageHours: traction.pairCreatedAt
                            ? (Date.now() - traction.pairCreatedAt) / (1000 * 60 * 60)
                            : 0,
                        liquidityUsd: traction.liquidity || 0,
                        marketCapUsd: traction.marketCap || 0,
                        volume5mUsd: traction.volume5m || 0,
                        buys5mCount: traction.buys5m || 0,
                        sells5mCount: traction.sells5m || 0,
                        priceChange1hPct: traction.priceChange1h || 0,
                        isPumpFun: traction.isPumpFun || false,
                        rugcheckScore: rugResult.rugcheckScore,
                        dangerRisksCount: rugResult.dangerRisksCount,
                        creatorHoldPct: rugResult.creatorHoldPct,
                        top10HolderPct: rugResult.top10HolderPct,
                        safetyIndex: rugResult.safetyIndex,
                        volumeSurge: traction.volumeSurge,
                        volScore: traction.volScore,
                        zScore: traction.zScore,
                        priceChange5mPct: traction.priceChange5m || 0,
                        priceChange15mPct: traction.priceChange15m || 0,
                        creatorTokensCreated: creatorProfile?.tokensCreated,
                        creatorRuggedTokens: creatorProfile?.ruggedTokens,
                        creatorRiskScore: creatorProfile?.riskScore,
                        hasWebsite: Boolean(traction.socials?.website?.trim()),
                        hasTwitter: Boolean(traction.socials?.twitter?.trim()),
                        hasTelegram: Boolean(traction.socials?.telegram?.trim()),
                        isDexPaidUpdated: Boolean(
                            traction.socials?.website?.trim() ||
                            traction.socials?.twitter?.trim() ||
                            traction.socials?.telegram?.trim(),
                        ),
                        isCommunityTakeover,
                        tokenName: traction.tokenName || traction.symbol || 'Unknown',
                        whaleSignalScore: whaleSignal.score,
                        route: finalMetadata.route,
                    },
                );
                finalMetadata.positionSizeMultiplier = aiResult.positionSizeMultiplier;
                finalMetadata.aiDecisionSnapshotId = aiResult.aiDecisionSnapshotId;

                if (aiResult.action !== 'buy' || aiResult.cuanConvictionScore < aiThreshold) {
                    this.logger.debug(
                        `[${tokenMint}] [ROUTE: ${route}] AI rejected signal. Score=${aiResult.cuanConvictionScore}, Threshold=${aiThreshold}, Action=${aiResult.action}.`,
                    );
                    return {
                        safe: false,
                        reason: 'ai_rejected',
                        metadata: finalMetadata,
                    };
                }
            }

            this.logger.log(
                `[${tokenMint}] ✅ [ROUTE: ${route}] Passed Advanced Filters (VoL: ${traction.volScore?.toFixed(3)}, Z: ${traction.zScore?.toFixed(1)}, Safety: ${rugResult.safetyIndex?.toFixed(2)}, isCTO: ${rugResult.isCTO}). Ready!`,
            );
            return {
                safe: true,
                metadata: finalMetadata,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] Analysis failed: ${msg}`);
            return { safe: false, reason: 'error' };
        }
    }

    async getTokenMetadata(tokenMint: string): Promise<TokenMetadata> {
        const traction = await this.checkMarketTraction(tokenMint);
        return {
            liquidity: traction.liquidity || 0,
            pairAddress: traction.pairAddress,
            marketCap: traction.marketCap || 0,
            mcap: traction.marketCap,
            pairCreatedAt: traction.pairCreatedAt,
            symbol: traction.symbol,
            tokenName: traction.tokenName,
            socials: traction.socials,
            volumeSurge: traction.volumeSurge,
            isPumpFun: traction.isPumpFun,
            hasWebsite: Boolean(traction.socials?.website?.trim()),
            hasTwitter: Boolean(traction.socials?.twitter?.trim()),
            hasTelegram: Boolean(traction.socials?.telegram?.trim()),
            isDexPaidUpdated: Boolean(
                traction.socials?.website?.trim() ||
                traction.socials?.twitter?.trim() ||
                traction.socials?.telegram?.trim(),
            ),
        };
    }

    private async getJupiterPrice(tokenMint: string): Promise<number | null> {
        try {
            // Routed through JupiterLimiter (not raw axios) so this shares the throttled
            // Jupiter API budget/queue with every other Jupiter call instead of bypassing it.
            // 'BUY' priority: informational-only call site, not part of a protective SELL's
            // own critical path (see jupiter-limiter.ts's class doc).
            const response = await JupiterLimiter.get<
                Record<string, { usdPrice?: number } | undefined>
            >(`https://api.jup.ag/price/v3?ids=${tokenMint}`, 'BUY', {
                timeout: 3000,
                headers: { 'x-api-key': this.jupiterApiKey },
                httpsAgent: this.getHttpsAgent(),
            });
            return response.data?.[tokenMint]?.usdPrice || null;
        } catch {
            return null;
        }
    }

    private async checkTokenSecurityRPC(
        tokenMint: string,
    ): Promise<{ passed: boolean; permanent: boolean }> {
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

                const maxTransferFeeBps = Number.parseFloat(
                    String(this.configService.get('MAX_TOKEN_TRANSFER_FEE_BPS', '300')),
                );
                const safety = evaluateMintSafety(mintInfo, maxTransferFeeBps);
                if (!safety.safe) {
                    this.logger.warn(`[${tokenMint}] Unsafe mint configuration: ${safety.reason}.`);
                    return { passed: false, permanent: true };
                }

                return { passed: true, permanent: false };
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
        return { passed: false, permanent: false }; // All retries failed (probably temporary RPC error)
    }

    private async checkMarketTraction(tokenMint: string): Promise<{
        passed: boolean;
        liquidity?: number;
        marketCap?: number;
        velocity?: number;
        socials?: TokenMetadata['socials'];
        reason?: string;
        permanent?: boolean;
        awaitingAmmPair?: boolean;
        symbol?: string;
        pairAddress?: string;
        pairCreatedAt?: number;
        volumeSurge?: number;
        volScore?: number;
        zScore?: number;
        priceChange1h?: number;
        priceChange5m?: number;
        priceUsd?: number;
        priceChange15m?: number;
        isPumpFun?: boolean;
        volume5m?: number;
        buys5m?: number;
        sells5m?: number;
        tokenName?: string;
    }> {
        try {
            const minLiq = Number.parseFloat(
                this.configService.get<string>('MIN_LIQUIDITY_USD', '7500'),
            );
            const minVol = Number.parseFloat(
                this.configService.get<string>('MIN_VOLUME_USD', '200'),
            );
            const minBuys = Number.parseInt(this.configService.get<string>('MIN_BUY_COUNT', '3'));
            const minVelocity = Number.parseFloat(
                this.configService.get<string>('MIN_VOLUME_MCAP_RATIO', '0.02'),
            );
            const minVlRatio = Number.parseFloat(
                this.configService.get<string>('MIN_VL_RATIO', '0'),
            );
            const minMCap = Number.parseFloat(this.configService.get<string>('MIN_MCAP', '5000'));
            const maxMCap = Number.parseFloat(this.configService.get<string>('MAX_MCAP', '300000'));
            const minAge = Number.parseFloat(
                this.configService.get<string>('MIN_AGE_HOURS', '0.02'),
            );
            const minConfidence = Number.parseFloat(
                this.configService.get<string>('MIN_BUY_CONFIDENCE', '0.60'),
            );
            const minPriceChange5m = Number.parseFloat(
                this.configService.get<string>('MIN_PRICE_CHANGE_5M_PCT', '0'),
            );
            const bearishReboundConfig: BearishReboundConfig = {
                hardFloorPct: Number.parseFloat(
                    this.configService.get<string>('BEARISH_REBOUND_1H_FLOOR_PCT', '-60'),
                ),
                minRebound5mPct: Number.parseFloat(
                    this.configService.get<string>('BEARISH_REBOUND_MIN_5M_PCT', '3'),
                ),
            };

            const response = await DexLimiter.get<{ pairs: DexScreenerPair[] }>(
                `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
                {
                    timeout: 5000,
                    httpsAgent: this.getHttpsAgent(),
                },
            );
            const pairs = response.data.pairs || [];
            const pair = selectBestDexScreenerPair(pairs, tokenMint);
            if (!pair) {
                this.logger.debug(
                    `[${tokenMint}] Market pair selection failed: no_solana_pair pairsCount=${pairs.length}`,
                );
                return { passed: false, reason: 'no_dex_pair', permanent: false };
            }

            const liquidity = pair.liquidity?.usd || 0;
            const priceUsd = Number.parseFloat(pair.priceUsd || '0') || 0;
            const volume5m = pair.volume?.m5 || 0;
            const volumeH1 = pair.volume?.h1 || 0;
            const txns5m = pair.txns?.m5 || {};
            const buys5m = txns5m.buys || 0;
            const sells5m = txns5m.sells || 0;
            // Already present in every DexScreener response and in the DTO, but unread until now.
            const txnsH1 = pair.txns?.h1 || {};
            const buysH1 = txnsH1.buys || 0;
            const sellsH1 = txnsH1.sells || 0;
            const marketCap = pair.fdv || 0;
            const symbol = pair.baseToken?.symbol;
            const tokenName = pair.baseToken?.name || pair.baseToken?.symbol || symbol;
            this.recordSeenToken(tokenName, volume5m);
            const pairCreatedAt = pair.pairCreatedAt || 0;
            const socials = {
                twitter: pair.info?.socials?.find((s) => s.type === 'twitter')?.url,
                telegram: pair.info?.socials?.find((s) => s.type === 'telegram')?.url,
                website: pair.info?.websites?.[0]?.url,
            };
            const logMarketMetricReject = (reason: string): void => {
                const ageSeconds = pairCreatedAt
                    ? Math.max((Date.now() - pairCreatedAt) / 1000, 0)
                    : 0;
                this.logger.debug(
                    `[${tokenMint}] Market metric context reason=${reason} pairsCount=${pairs.length} selectedDexId=${pair.dexId || 'unknown'} liquidity=${liquidity.toFixed(2)} volume5m=${volume5m.toFixed(2)} buys5m=${buys5m} sells5m=${sells5m} buysH1=${buysH1} sellsH1=${sellsH1} buyShareH1=${formatBuyShare(buyShare({ buys: buysH1, sells: sellsH1 }))} marketCap=${marketCap.toFixed(2)} ageSeconds=${ageSeconds.toFixed(1)}`,
                );
            };

            // 🛡️ HARD REJECT: Token tanpa liquidity = impossible to sell tanpa massive slippage
            if (!liquidity || liquidity < 1000) {
                const isYoung = Date.now() - (pair.pairCreatedAt || 0) < 1000 * 60 * 60; // < 1 hour
                // DexScreener never reports `liquidity` for a pump.fun bonding-curve pair, so a
                // token whose only pair is still the curve reads as zero even while it trades
                // heavily; its AMM pair simply is not indexed yet. That is worth waiting for.
                // A token that already HAS an AMM pair and still shows a few dollars of
                // liquidity is just dead, and retrying it only burns DexScreener budget.
                const awaitingAmmPair =
                    (pair.dexId || '').toLowerCase() === 'pumpfun' &&
                    !Number.isFinite(pair.liquidity?.usd);
                logMarketMetricReject('zero_liquidity');
                return {
                    passed: false,
                    reason: 'zero_liquidity',
                    permanent: !isYoung, // Hanya permanent kalau koin sudah lama tapi likuiditas tetep 0
                    awaitingAmmPair,
                    liquidity,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                };
            }

            // 🚀 EARLY REJECT: Cek filter murah dulu sebelum kalkulasi mahal
            if (liquidity < minLiq) {
                logMarketMetricReject('low_metrics');
                return {
                    passed: false,
                    reason: 'low_metrics',
                    liquidity,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                };
            }
            if (volume5m < minVol) {
                logMarketMetricReject('low_metrics');
                return {
                    passed: false,
                    reason: 'low_metrics',
                    liquidity,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                };
            }
            if (buys5m < minBuys) {
                logMarketMetricReject('low_metrics');
                return {
                    passed: false,
                    reason: 'low_metrics',
                    liquidity,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                };
            }

            // 1. VoL (Velocity of Liquidity)
            // Rumus: (Volume 5m / Liquidity) * Confidence Score
            const confidenceScore = buys5m / (buys5m + sells5m || 1);
            const vlRatio = volume5m / (liquidity || 1);
            const volScore = vlRatio * confidenceScore;

            // 2. Volume Z-Score (Anomaly Detection)
            // Pseudo Z-Score: (Current - Avg) / StdDev (Asumsi StdDev = Avg * 0.5)
            // The baseline is scaled to the history the token actually has. Dividing by a flat 12
            // assumed a full hour, so on anything younger volume1h WAS volume5m and the volume
            // cancelled out — every fresh token reported exactly surge 12.00 / z 22.00 regardless
            // of how much it traded. See volume-baseline.ts.
            const avgVol5m = averageVolume5m(volumeH1, pairCreatedAt ? Date.now() - pairCreatedAt : undefined);
            const zScore = (volume5m - avgVol5m) / (avgVol5m * 0.5 || 1);

            // Zero sells is common during the first seconds of a launch. It is not proof of a
            // honeypot; RPC/RugCheck and the pre-buy reverse quote enforce actual sellability.
            if (buys5m >= 10 && sells5m === 0) {
                this.logger.debug(
                    `[${tokenMint}] Early one-sided flow detected (${buys5m} buys / 0 sells); continuing to on-chain and reverse-quote safety checks.`,
                );
            }

            const velocity = volume5m / (marketCap || 1);
            const isPumpFun = pair.info?.websites?.some((w) => w.url.includes('pump.fun')) || false;
            const priceChange1h = pair.priceChange?.h1 || 0;
            const priceChange5m = pair.priceChange?.m5 || 0;

            if (marketCap < minMCap || marketCap > maxMCap) {
                const isPerm = marketCap > maxMCap; // MCap kegedean baru permanent
                logMarketMetricReject(marketCap > maxMCap ? 'mcap_too_high' : 'mcap_too_low');
                return {
                    passed: false,
                    reason: marketCap > maxMCap ? 'mcap_too_high' : 'mcap_too_low',
                    permanent: isPerm,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange5m: pair.priceChange?.m5 || 0,
                    priceChange15m: pair.priceChange?.m15 || 0,
                    priceChange1h,
                    isPumpFun,
                };
            }

            const ageHours = (Date.now() - (pair.pairCreatedAt || 0)) / (1000 * 60 * 60);
            const maxAge = Number.parseFloat(
                this.configService.get<string>('MAX_AGE_HOURS', '24.0'),
            );
            const establishedMaxAge = Number.parseFloat(
                this.configService.get<string>('ESTABLISHED_MAX_AGE_HOURS', '72.0'),
            );
            const absoluteMaxAge = Math.max(maxAge, establishedMaxAge);

            if (ageHours < minAge || ageHours > maxAge) {
                const isTooOld = ageHours > maxAge;
                const isPerm = isTooOld && ageHours > absoluteMaxAge;
                logMarketMetricReject(isTooOld ? 'too_old' : 'too_young');
                return {
                    passed: false,
                    reason: isTooOld ? 'too_old' : 'too_young',
                    permanent: isPerm,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange5m: pair.priceChange?.m5 || 0,
                    priceChange15m: pair.priceChange?.m15 || 0,
                    priceChange1h,
                    isPumpFun,
                };
            }

            const volumeSurge = volume5m / (avgVol5m || 1);
            const minSurge = Number.parseFloat(
                this.configService.get<string>('ANALYZER_MIN_VOLUME_SURGE', '1.5'),
            );
            if (volumeSurge < minSurge) {
                logMarketMetricReject('low_surge');
                return {
                    passed: false,
                    reason: 'low_surge',
                    volumeSurge,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange5m: pair.priceChange?.m5 || 0,
                    priceChange15m: pair.priceChange?.m15 || 0,
                    priceChange1h,
                    isPumpFun,
                };
            }
            const bearishDecision = evaluateBearishRebound(
                priceChange1h,
                priceChange5m,
                bearishReboundConfig,
            );
            if (!bearishDecision.allowed) {
                logMarketMetricReject('bearish_trend');
                return {
                    passed: false,
                    reason: 'bearish_trend',
                    permanent: bearishDecision.permanent,
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange5m,
                    priceChange15m: pair.priceChange?.m15 || 0,
                    priceChange1h,
                    isPumpFun,
                };
            }

            if (vlRatio < minVlRatio) {
                logMarketMetricReject('low_vl_ratio');
                return {
                    passed: false,
                    reason: 'low_vl_ratio',
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange1h,
                    isPumpFun,
                    volume5m,
                    buys5m,
                    sells5m,
                };
            }

            // 📊 BUY VS SELL RATIO (Confidence Score)
            if (confidenceScore < minConfidence) {
                logMarketMetricReject('low_buy_confidence');
                return {
                    passed: false,
                    reason: 'low_buy_confidence',
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange5m: pair.priceChange?.m5 || 0,
                    priceChange15m: pair.priceChange?.m15 || 0,
                    priceChange1h,
                    isPumpFun,
                };
            }

            const buySellRatioThreshold = Math.max(
                1,
                Number.parseFloat(
                    String(this.configService.get('BUY_SELL_RATIO_THRESHOLD', '1.2')),
                ),
            );
            // The 1h companion to the 5m gate below. Measured as a share rather than a ratio
            // because that is the question being asked: what fraction of the hour's trades were
            // buys. A five-minute burst can look like momentum while the surrounding hour is net
            // distribution — the token that prompted this read 49.4% buy share over 24h while its
            // 5m window looked fine. Fails open when the hour has no data, so freshly migrated
            // tokens are not shut out.
            const minH1BuyShare = Number.parseFloat(
                String(this.configService.get('MIN_H1_BUY_SHARE', '0')),
            );
            if (failsBuyShare({ buys: buysH1, sells: sellsH1 }, minH1BuyShare)) {
                logMarketMetricReject('low_h1_buyer_dominance');
                return {
                    passed: false,
                    reason: 'low_h1_buyer_dominance',
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volumeSurge,
                    volScore,
                    zScore,
                    priceChange5m: pair.priceChange?.m5 || 0,
                    priceChange15m: pair.priceChange?.m15 || 0,
                    priceChange1h,
                    isPumpFun,
                    volume5m,
                    buys5m,
                    sells5m,
                };
            }
            if (sells5m > 0 && buys5m < sells5m * buySellRatioThreshold) {
                logMarketMetricReject('low_buyer_dominance');
                return {
                    passed: false,
                    reason: 'low_buyer_dominance',
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volumeSurge,
                    volScore,
                    zScore,
                    priceChange5m: pair.priceChange?.m5 || 0,
                    priceChange15m: pair.priceChange?.m15 || 0,
                    priceChange1h,
                    isPumpFun,
                    volume5m,
                    buys5m,
                    sells5m,
                };
            }

            if (priceChange5m < minPriceChange5m) {
                logMarketMetricReject('negative_short_term_momentum');
                return {
                    passed: false,
                    reason: 'negative_short_term_momentum',
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volumeSurge,
                    volScore,
                    zScore,
                    priceChange5m,
                    priceChange15m: pair.priceChange?.m15 || 0,
                    priceChange1h,
                    isPumpFun,
                    volume5m,
                    buys5m,
                    sells5m,
                };
            }

            if (velocity < minVelocity) {
                logMarketMetricReject('low_velocity');
                return {
                    passed: false,
                    reason: 'low_velocity',
                    marketCap,
                    symbol,
                    pairCreatedAt,
                    socials,
                    liquidity,
                    volScore,
                    zScore,
                    priceChange5m: pair.priceChange?.m5 || 0,
                    priceChange15m: pair.priceChange?.m15 || 0,
                    priceChange1h,
                    isPumpFun,
                };
            }

            // Buy vs sell VOLUME, as opposed to the transaction counts every gate above uses. The
            // two genuinely disagree: the token that prompted this read 49.4% of trades on the buy
            // side but 50.6% of volume, because sells were more numerous yet smaller. Counts alone
            // cannot see that.
            //
            // Deliberately the LAST gate in the chain. It is the only one that costs an external
            // API call (Helius, 1-3 paginated requests), so it only ever runs for a token that has
            // already survived every cheap check — a handful per hour rather than thousands.
            const enableH1FlowVolume = String(
                this.configService.get('ENABLE_H1_FLOW_VOLUME', 'false'),
            ).toLowerCase() === 'true';
            const minH1BuyVolumeShare = Number.parseFloat(
                String(this.configService.get('MIN_H1_BUY_VOLUME_SHARE', '0')),
            );
            if (enableH1FlowVolume && minH1BuyVolumeShare > 0 && pair.pairAddress) {
                const flow = await this.flowVolumeService.getHourlyFlowVolume(
                    tokenMint,
                    pair.pairAddress,
                );
                if (flow) {
                    const failsVolumeShare = failsBuyShare(
                        { buys: flow.buyVolumeSol, sells: flow.sellVolumeSol },
                        minH1BuyVolumeShare,
                    );
                    if (failsVolumeShare) {
                        logMarketMetricReject('low_h1_buy_volume');
                        return {
                            passed: false,
                            reason: 'low_h1_buy_volume',
                            marketCap,
                            symbol,
                            pairCreatedAt,
                            socials,
                            liquidity,
                            volumeSurge,
                            volScore,
                            zScore,
                            priceChange5m: pair.priceChange?.m5 || 0,
                            priceChange15m: pair.priceChange?.m15 || 0,
                            priceChange1h,
                            isPumpFun,
                            volume5m,
                            buys5m,
                            sells5m,
                        };
                    }
                } else if (
                    String(this.configService.get('FLOW_VOLUME_FAIL_OPEN', 'true')).toLowerCase() !==
                    'true'
                ) {
                    // Only reachable when the operator has explicitly chosen strictness: a Helius
                    // outage would otherwise halt all trading, which is worse than a missed filter.
                    logMarketMetricReject('flow_volume_unavailable');
                    return {
                        passed: false,
                        reason: 'flow_volume_unavailable',
                        marketCap,
                        symbol,
                        pairCreatedAt,
                        socials,
                        liquidity,
                        volumeSurge,
                        volScore,
                        zScore,
                        priceChange5m: pair.priceChange?.m5 || 0,
                        priceChange15m: pair.priceChange?.m15 || 0,
                        priceChange1h,
                        isPumpFun,
                        volume5m,
                        buys5m,
                        sells5m,
                    };
                }
            }

            return {
                passed: true,
                liquidity,
                pairAddress: pair.pairAddress,
                marketCap,
                velocity,
                socials,
                symbol,
                tokenName,
                pairCreatedAt,
                priceUsd,
                volumeSurge,
                volScore,
                zScore,
                priceChange5m: pair.priceChange?.m5 || 0,
                priceChange15m: pair.priceChange?.m15 || 0,
                priceChange1h,
                isPumpFun,
                volume5m,
                buys5m,
                sells5m,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${tokenMint}] Traction check failed: ${msg}`);
            return { passed: false };
        }
    }

    private async resolveDns(hostname: string): Promise<string> {
        if (this.ipCache[hostname]) return this.ipCache[hostname];
        try {
            let response = await axios
                .get(`https://1.1.1.1/dns-query?name=${hostname}&type=A`, {
                    headers: { accept: 'application/dns-json' },
                    timeout: 5000,
                    httpsAgent: new https.Agent({ family: 4 }),
                })
                .catch(() => null);

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
                this.ipCache[hostname] = ip;
                return ip;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[${hostname}] DNS resolution failed: ${msg}`);
        }
        return hostname;
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

    public checkHolderConcentration(rugCheckData: RugCheckResponse, liquidityUsd = 0): boolean {
        try {
            const eligibleHolders = rugCheckData.holders
                .filter((holder: RugCheckHolder) => !holder.isInPool && !holder.isBurned)
                .sort((a, b) => b.share - a.share);
            const singleShare = eligibleHolders[0]?.share ?? 0;
            const top5Share = eligibleHolders
                .slice(0, 5)
                .reduce((sum: number, holder: RugCheckHolder) => sum + holder.share, 0);
            const top10Share = eligibleHolders
                .slice(0, 10)
                .reduce((sum: number, holder: RugCheckHolder) => sum + holder.share, 0);
            const aggressiveLiquidityFloor = Math.max(
                0,
                Number.parseFloat(
                    String(this.configService.get('AGGRESSIVE_HOLDER_MIN_LIQUIDITY_USD', '10000')),
                ),
            );
            const useAggressiveLimits = liquidityUsd >= aggressiveLiquidityFloor;
            const limit = (standardKey: string, aggressiveKey: string, fallback: number): number => {
                const key = useAggressiveLimits ? aggressiveKey : standardKey;
                return Math.max(0, Number.parseFloat(String(this.configService.get(key, fallback))));
            };
            const maxSingleShare = limit(
                'MAX_SINGLE_HOLDER_PCT',
                'AGGRESSIVE_MAX_SINGLE_HOLDER_PCT',
                useAggressiveLimits ? 12 : 8,
            );
            const maxTop5Share = limit(
                'MAX_TOP5_HOLDER_PCT',
                'AGGRESSIVE_MAX_TOP5_HOLDER_PCT',
                useAggressiveLimits ? 28 : 15,
            );
            const maxTop10Share = limit(
                'MAX_TOP10_HOLDER_PCT',
                'AGGRESSIVE_MAX_TOP10_HOLDER_PCT',
                useAggressiveLimits ? 35 : 20,
            );
            if (
                singleShare > maxSingleShare ||
                top5Share > maxTop5Share ||
                top10Share > maxTop10Share
            ) {
                this.logger.warn(
                    `Holder concentration rejected (liquidity=${liquidityUsd.toFixed(2)}): single=${singleShare.toFixed(2)}%, top5=${top5Share.toFixed(2)}%, top10=${top10Share.toFixed(2)}%.`,
                );
                return false;
            }
            const maxNormalisedScore = Number.parseFloat(
                String(
                    this.configService.get(
                        'RUGCHECK_MAX_NORMALISED_SCORE',
                        DEFAULT_MAX_NORMALISED_RISK_SCORE,
                    ),
                ),
            );
            if (
                exceedsRiskScore(rugCheckData.scoreNormalised, maxNormalisedScore) ||
                (rugCheckData.dangerReasons?.length || 0) > 0
            ) {
                return false;
            }
            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Holder concentration check failed safely: ${msg}`);
            return false;
        }
    }

    private toRugCheckResponse(
        data: RugCheckApiResponse,
        holders: RugCheckApiHolder[],
        markets: RugCheckMarket[],
        risks: RugCheckRisk[],
    ): RugCheckResponse {
        const normalizedHolders = holders.map((holder: RugCheckApiHolder): RugCheckHolder => {
            const owner = holder.owner.toLowerCase();
            return {
                address: holder.address,
                amount: Number.isFinite(holder.amount) ? holder.amount : 0,
                share: Number.isFinite(holder.pct) ? holder.pct : 0,
                isInPool: owner.includes('pool') || owner.includes('amm'),
                isBurned: owner === '1111111111111111111111111111111',
            };
        });
        const topHoldersPercentage = normalizedHolders
            .filter((holder: RugCheckHolder) => !holder.isInPool && !holder.isBurned)
            .slice(0, 10)
            .reduce((sum: number, holder: RugCheckHolder) => sum + holder.share, 0);
        const dangerReasons = selectBlockingDangerRisks(risks).map(
            (risk: RugCheckRisk) => risk.name,
        );

        return {
            mint: data.mint || '',
            score: data.score || 0,
            scoreNormalised: resolveNormalisedRiskScore(data.score_normalised),
            meta: {
                topHoldersPercentage,
                totalHolders: normalizedHolders.length,
                lpBurned: markets.some((market: RugCheckMarket) => market.lpType === 'burned'),
                lpLocked: markets.some((market: RugCheckMarket) => isMarketLpSafe(market)),
            },
            holders: normalizedHolders,
            dangerReasons,
        };
    }

    private async checkRugCheckAPI(
        tokenMint: string,
        liquidityUsd = 0,
        tokenAgeMs?: number,
    ): Promise<{
        passed: boolean;
        creator?: string;
        topHolder?: string;
        reason?: string;
        safetyIndex?: number;
        rugcheckScore?: number;
        dangerRisksCount?: number;
        creatorHoldPct?: number;
        top10HolderPct?: number;
        permanent?: boolean;
        isCTO?: boolean;
        creatorExited?: boolean;
    }> {
        try {
            const response = await axios.get<RugCheckApiResponse>(
                `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report`,
                {
                    timeout: 5000,
                    httpsAgent: this.getHttpsAgent(),
                },
            );

            if (!response.data)
                return { passed: false, reason: 'rugcheck_no_data', permanent: false };

            const topHolders = response.data.topHolders || [];
            const knownAccounts = response.data.knownAccounts || {};

            // 🛡️ SAFETY & HOLDER INDEX (Anti-Rug) - Saring dompet AMM, lockers, dan alamat sistem
            const filteredHolders = topHolders
                .filter((h) => {
                    const known = knownAccounts[h.address] || knownAccounts[h.owner];
                    const isExcludedType =
                        known && (known.type === 'AMM' || known.type === 'LOCKER');
                    const isSystemAccount = h.owner === '1111111111111111111111111111111';
                    return !isExcludedType && !isSystemAccount;
                })
                .sort((a, b) => (b.pct || 0) - (a.pct || 0));
            const markets = response.data.markets || [];
            const risks = response.data.risks || [];
            const rugCheckData = this.toRugCheckResponse(
                response.data,
                filteredHolders,
                markets,
                risks,
            );
            const holderMaxNormalisedScore = Number.parseFloat(
                String(
                    this.configService.get(
                        'RUGCHECK_MAX_NORMALISED_SCORE',
                        DEFAULT_MAX_NORMALISED_RISK_SCORE,
                    ),
                ),
            );
            const holderDataSettled = isHolderDataSettled(
                tokenAgeMs,
                Number.parseFloat(
                    String(
                        this.configService.get(
                            'HOLDER_DATA_SETTLE_MINUTES',
                            DEFAULT_HOLDER_DATA_SETTLE_MINUTES,
                        ),
                    ),
                ),
            );
            if (!this.checkHolderConcentration(rugCheckData, liquidityUsd)) {
                return {
                    passed: false,
                    reason:
                        exceedsRiskScore(rugCheckData.scoreNormalised, holderMaxNormalisedScore)
                            ? 'high_risk_score'
                            : rugCheckData.dangerReasons?.length
                              ? 'danger_risks_detected'
                              : 'high_concentration',
                    safetyIndex: 1 - rugCheckData.meta.topHoldersPercentage / 100,
                    // RugCheck's holder table needs minutes to settle after a migration: the same
                    // token read single=79.33% seconds in and 0.05% once the pool was labelled.
                    // Rejecting on the early snapshot is fine; blacklisting on it is not.
                    permanent: holderDataSettled,
                    isCTO: false,
                };
            }

            // 🧑‍💻 CREATOR BALANCE CHECK (Anti-Dump)
            const creator = response.data.creator;
            let ownership: CreatorOwnershipResult = {
                creatorPct: null,
                isCTO: false,
                creatorExited: false,
                reliable: true,
            };
            if (creator) {
                // Gunakan RPC langsung alih-alih data topHolders RugCheck yang tidak lengkap
                ownership = await this.getCreatorOwnership(creator, tokenMint);
                if (!ownership.reliable) {
                    return {
                        passed: false,
                        reason: 'creator_data_unavailable',
                        permanent: false,
                        isCTO: false,
                    };
                }
            }
            const creatorPct = ownership.creatorPct ?? 0;
            const creatorExited = creator ? Boolean(ownership.creatorExited) : false;
            const isCTO = false;

            const requireDevZeroBalance = ['true', '1', 'yes', 'on'].includes(
                String(this.configService.get('REQUIRE_DEV_ZERO_BALANCE', 'false'))
                    .trim()
                    .toLowerCase(),
            );
            const maxCreatorHoldPctForBuy = Math.max(
                0,
                Number.parseFloat(
                    String(this.configService.get('MAX_CREATOR_HOLD_PCT_FOR_BUY', '0.1')),
                ),
            );
            if (
                requireDevZeroBalance &&
                (!creator || !Number.isFinite(creatorPct) || creatorPct > maxCreatorHoldPctForBuy)
            ) {
                this.logger.warn(
                    `[${tokenMint}] Creator is not effectively empty (${creatorPct.toFixed(4)}%). Skip.`,
                );
                return {
                    passed: false,
                    reason: 'creator_not_zero',
                    permanent: true,
                    isCTO,
                };
            }

            // Hitung safetyIndex menggunakan persentase (pct) langsung dari API
            const top10SumPct = filteredHolders
                .slice(0, 10)
                .reduce((sum: number, h: RugCheckApiHolder) => sum + (h.pct || 0), 0);
            const safetyIndex = 1 - top10SumPct / 100;

            const aggressiveLiquidityFloor = Number.parseFloat(
                String(this.configService.get('AGGRESSIVE_HOLDER_MIN_LIQUIDITY_USD', '10000')),
            );
            const useAggressiveSafetyFloor =
                Number.isFinite(aggressiveLiquidityFloor) && liquidityUsd >= aggressiveLiquidityFloor;
            const defaultSafetyIndex = isCTO ? '0.20' : '0.65';
            const minSafetyIndex = Number.parseFloat(
                this.configService.get<string>(
                    useAggressiveSafetyFloor
                        ? 'AGGRESSIVE_RUGCHECK_MIN_SAFETY_INDEX'
                        : 'RUGCHECK_MIN_SAFETY_INDEX',
                    useAggressiveSafetyFloor ? '0.65' : defaultSafetyIndex,
                ),
            );
            if (safetyIndex < minSafetyIndex) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 High Concentration: Top 10 pegang ${(1 - safetyIndex) * 100}%. Skip. (isCTO: ${isCTO})`,
                );
                return {
                    passed: false,
                    reason: 'high_concentration',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            // 🔥 LP Safety Check: Accept burned OR locked (PumpFun uses locked mechanism)
            const isPumpFunToken = tokenMint.toLowerCase().endsWith('pump');
            const minLpLockedPct = Number.parseFloat(
                String(this.configService.get('MIN_LP_LOCKED_PCT', DEFAULT_MIN_LP_LOCKED_PCT)),
            );
            const lpSafe = isLpSafe(markets, minLpLockedPct);
            if (markets.length === 0 && !isPumpFunToken) {
                return {
                    passed: false,
                    reason: 'lp_status_unavailable',
                    safetyIndex,
                    permanent: false,
                    isCTO,
                };
            }
            // PumpFun without market data can still be on its bonding curve. Once RugCheck
            // reports a market, every token must prove that LP is burned or locked.
            if (!lpSafe && markets.length > 0) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 LP NOT BURNED/LOCKED (maxLockedPct=${maxLpLockedPct(markets).toFixed(1)}%, min=${minLpLockedPct}%). Skip.`,
                );
                return {
                    passed: false,
                    reason: 'lp_not_burned',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            const score = response.data.score || 0;
            const scoreNormalised = resolveNormalisedRiskScore(response.data.score_normalised);
            const maxNormalisedRiskScore = Number.parseFloat(
                String(
                    this.configService.get(
                        'RUGCHECK_MAX_NORMALISED_SCORE',
                        DEFAULT_MAX_NORMALISED_RISK_SCORE,
                    ),
                ),
            );
            if (exceedsRiskScore(scoreNormalised, maxNormalisedRiskScore)) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 High Risk Score: normalised=${scoreNormalised}/${maxNormalisedRiskScore} (raw=${score}). Skip.`,
                );
                return {
                    passed: false,
                    reason: 'high_risk_score',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            // ⛔ HONEYPOT & PERMISSIONS CHECK
            const hasHoneypotRisk = risks.some(
                (r) =>
                    r.name.toLowerCase().includes('honeypot') ||
                    r.name.toLowerCase().includes('freeze') ||
                    r.name.toLowerCase().includes('mint authority'),
            );

            if (hasHoneypotRisk) {
                this.logger.warn(`[${tokenMint}] 🛑 HONEYPOT/FREEZE RISK detected. Skip.`);
                return {
                    passed: false,
                    reason: 'honeypot_detected',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            // Liquidity is enforced by MIN_LIQUIDITY_USD, stricter and fresher than RugCheck's
            // label, so it must not also act as a permanent RugCheck blacklist.
            const highRisks = selectBlockingDangerRisks(risks);
            if (highRisks.length > 0) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 Danger risk detected (${highRisks.map((r) => r.name).join(', ')}). Skip.`,
                );
                return {
                    passed: false,
                    reason: 'danger_risks_detected',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            if (creator && creatorPct > maxCreatorHoldPctForBuy) {
                this.logger.warn(
                    `[${tokenMint}] 🛑 Creator holds too much (${creatorPct.toFixed(2)}%). Skip.`,
                );
                return {
                    passed: false,
                    reason: 'creator_holds_too_much',
                    safetyIndex,
                    permanent: true,
                    isCTO,
                };
            }

            return {
                passed: true,
                creator: response.data.creator,
                topHolder: filteredHolders
                    .map((holder) => holder.address || holder.owner)
                    .find((address) => Boolean(address && address !== response.data.creator)),
                safetyIndex,
                rugcheckScore: score,
                dangerRisksCount: highRisks.length,
                creatorHoldPct: creatorPct,
                top10HolderPct: top10SumPct,
                isCTO,
                creatorExited,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`RugCheck API Error: ${msg}`);
            return { passed: false, reason: 'rugcheck_error', permanent: false };
        }
    }

    private async getCreatorOwnership(
        creatorAddress: string,
        tokenMint: string,
    ): Promise<CreatorOwnershipResult> {
        try {
            const { PublicKey } = await import('@solana/web3.js');
            const creatorKey = new PublicKey(creatorAddress);
            const mintKey = new PublicKey(tokenMint);

            const creatorBalance = await this.getCreatorTokenBalanceWithRetry(creatorKey, mintKey);
            if (creatorBalance === null) {
                this.creatorRpcFailureCount++;
                this.logger.warn(
                    `[metrics] creator_rpc_failure=${this.creatorRpcFailureCount} token=${tokenMint}`,
                );
                return { creatorPct: null, isCTO: false, reliable: false };
            }

            const accountInfo = await this.connection.getAccountInfo(mintKey);
            if (!accountInfo) {
                this.creatorRpcFailureCount++;
                this.logger.warn(
                    `[metrics] creator_rpc_failure=${this.creatorRpcFailureCount} token=${tokenMint}`,
                );
                return { creatorPct: null, isCTO: false, reliable: false };
            }
            const { getMint } = await import('@solana/spl-token');
            const mintInfo = await getMint(this.connection, mintKey, undefined, accountInfo.owner);
            const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);

            if (totalSupply <= 0) {
                return { creatorPct: null, isCTO: false, reliable: false };
            }
            const creatorPct = (creatorBalance / totalSupply) * 100;
            return { creatorPct, isCTO: false, creatorExited: creatorPct < 0.1, reliable: true };
        } catch (error) {
            this.logger.error(
                `Failed to get creator ownership: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.creatorRpcFailureCount++;
            this.logger.warn(
                `[metrics] creator_rpc_failure=${this.creatorRpcFailureCount} token=${tokenMint}`,
            );
            return { creatorPct: null, isCTO: false, reliable: false };
        }
    }

    private async getCreatorTokenBalanceWithRetry(
        creatorKey: PublicKey,
        mintKey: PublicKey,
    ): Promise<number | null> {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const accounts = await this.connection.getParsedTokenAccountsByOwner(creatorKey, {
                    mint: mintKey,
                });
                return accounts.value.reduce((sum, account) => {
                    const amount = account.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
                    return sum + amount;
                }, 0);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.logger.warn(`Creator balance RPC failed (attempt ${attempt}/3): ${msg}`);
                if (attempt < 3) {
                    await new Promise((res) => setTimeout(res, 300 * attempt));
                }
            }
        }
        return null;
    }
}
