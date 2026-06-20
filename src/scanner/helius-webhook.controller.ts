import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ScannerService } from './scanner.service';
import { HeliusTokenTransfer, HeliusTransaction } from '../dto/helius-webhook.dto';

@Controller('helius')
export class HeliusWebhookController {
    private readonly logger = new Logger(HeliusWebhookController.name);

    constructor(private readonly scannerService: ScannerService) {}

    @Post('webhook')
    @HttpCode(200)
    async handleHeliusPush(@Body() transactions: HeliusTransaction[]): Promise<void> {
        try {
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
