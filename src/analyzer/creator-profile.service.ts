import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CreatorProfileService {
    private readonly logger = new Logger(CreatorProfileService.name);

    constructor(private readonly prismaService: PrismaService) {}

    /**
     * Evaluates a creator's profile.
     * If the profile doesn't exist, it creates a default one (Self-Learning mode).
     * @param address The creator's wallet address
     * @returns The CreatorProfile from the database
     */
    async evaluateCreator(address: string) {
        try {
            let profile = await this.prismaService.creatorProfile.findUnique({
                where: { address },
            });

            if (!profile) {
                // Self-learning: If we haven't seen this dev, assume they are new/neutral for now.
                // Later we can integrate Helius or BubbleMaps API here.
                profile = await this.prismaService.creatorProfile.create({
                    data: {
                        address,
                        tokensCreated: 1,
                        ruggedTokens: 0,
                        riskScore: 0,
                        isBlacklisted: false,
                        tags: ['New Dev'],
                    },
                });
                this.logger.debug(`[CreatorProfile] Created new profile for ${address}.`);
            }

            // Dynamically calculate risk score based on rugged history
            if (profile.ruggedTokens > 0) {
                const newRiskScore = Math.min(
                    (profile.ruggedTokens / profile.tokensCreated) * 100,
                    100,
                );
                const shouldBlacklist = newRiskScore >= 80 || profile.isBlacklisted;

                if (
                    profile.riskScore !== newRiskScore ||
                    profile.isBlacklisted !== shouldBlacklist
                ) {
                    profile = await this.prismaService.creatorProfile.update({
                        where: { address },
                        data: {
                            riskScore: newRiskScore,
                            isBlacklisted: shouldBlacklist,
                            lastActiveAt: new Date(),
                        },
                    });
                }
            }

            return profile;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[CreatorProfile] Error evaluating creator ${address}: ${msg}`);
            // Return a safe mock profile to not block execution if DB fails temporarily
            return {
                address,
                tokensCreated: 1,
                ruggedTokens: 0,
                riskScore: 0,
                isBlacklisted: false,
                reason: null,
                tags: [],
            };
        }
    }

    /**
     * Marks a creator as a rugger/dumper. Used by TradeService when a dump is detected.
     * @param address The creator's wallet address
     * @param reason The reason for the penalty (e.g. 'RUGPULL', 'DEV_DUMP')
     */
    async penalizeCreator(address: string, reason: string) {
        try {
            const profile = await this.prismaService.creatorProfile.findUnique({
                where: { address },
            });

            const currentRugged = profile ? profile.ruggedTokens : 0;
            const currentCreated = profile ? profile.tokensCreated : 1;
            const existingTags = profile ? profile.tags : [];

            const newTags = Array.from(new Set([...existingTags, 'Serial Rugger']));

            await this.prismaService.creatorProfile.upsert({
                where: { address },
                update: {
                    ruggedTokens: currentRugged + 1,
                    isBlacklisted: true,
                    reason,
                    tags: newTags,
                    lastActiveAt: new Date(),
                },
                create: {
                    address,
                    tokensCreated: currentCreated,
                    ruggedTokens: 1,
                    isBlacklisted: true,
                    reason,
                    tags: ['Serial Rugger'],
                },
            });

            this.logger.warn(
                `[CreatorProfile] 🚨 PENALIZED: Creator ${address} has been blacklisted for ${reason}.`,
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`[CreatorProfile] Failed to penalize creator ${address}: ${msg}`);
        }
    }
}
