import { Body, Controller, Headers, HttpCode, HttpStatus, Logger, Post, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScannerService } from './scanner.service';
import { HeliusTokenTransfer, HeliusTransaction } from '../dto/helius-webhook.dto';
import { Response } from 'express';

@Controller('helius')
export class HeliusWebhookController {
    private readonly logger = new Logger(HeliusWebhookController.name);

    constructor(
        private readonly scannerService: ScannerService,
        private readonly configService: ConfigService,
    ) {}

    @Post('webhook')
    @HttpCode(200)
    async handleHeliusPush(
        @Body() transactions: HeliusTransaction[],
        @Headers('authorization') authorization: string | undefined,
        @Headers('x-helius-webhook-secret') webhookSecret: string | undefined,
        @Res({ passthrough: true }) res: Response,
    ): Promise<void> {
        try {
            if (!this.isWebhookAuthorized(authorization, webhookSecret)) {
                this.logger.warn('Rejected Helius webhook request: invalid auth header.');
                res.status(HttpStatus.OK);
                return;
            }

            const safeTransactions = Array.isArray(transactions) ? transactions : [];
            const mintAddresses = new Set<string>();

            for (const transaction of safeTransactions) {
                for (const transfer of transaction.tokenTransfers ?? []) {
                    this.collectMintAddress(transfer, mintAddresses);
                }
            }

            for (const mintAddress of mintAddresses) {
                void this.scannerService.processNewToken(mintAddress).catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    this.logger.error(`[HeliusWebhook] Failed to queue ${mintAddress}: ${message}`);
                });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Helius webhook parsing failed: ${message}`);
        }
    }

    private isWebhookAuthorized(
        authorization: string | undefined,
        webhookSecret: string | undefined,
    ): boolean {
        const expectedSecret = this.configService.get<string>('HELIUS_WEBHOOK_SECRET') || '';
        if (!expectedSecret) {
            return true;
        }

        if (webhookSecret && webhookSecret === expectedSecret) {
            return true;
        }

        if (!authorization) {
            return false;
        }

        const bearerPrefix = 'Bearer ';
        if (authorization.startsWith(bearerPrefix)) {
            const token = authorization.slice(bearerPrefix.length).trim();
            return token === expectedSecret;
        }

        return authorization === expectedSecret;
    }

    private collectMintAddress(
        transfer: HeliusTokenTransfer,
        mintAddresses: Set<string>,
    ): void {
        const mintAddress = transfer.mint.trim();
        if (mintAddress.length > 0) {
            mintAddresses.add(mintAddress);
        }
    }
}
