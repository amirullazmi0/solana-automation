import {
    Body,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Logger,
    Post,
    Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { ReportingService } from '../reporting/reporting.service';
import {
    HeliusNativeTransfer,
    HeliusWebhookPayload,
    HeliusWebhookTransaction,
    HeliusTokenTransfer,
} from '../dto/helius-webhook.dto';
import { ScannerService } from './scanner.service';

interface NativeDepositBatch {
    walletPublicKey: string;
    amountLamports: number;
}

interface DepositLedgerInsertResult {
    chatId: string;
    newBalanceSol: number;
    amountSol: number;
}

@Controller('helius')
export class HeliusWebhookController {
    private readonly logger = new Logger(HeliusWebhookController.name);

    constructor(
        private readonly scannerService: ScannerService,
        private readonly prismaService: PrismaService,
        private readonly reportingService: ReportingService,
        private readonly configService: ConfigService,
    ) {}

    @Post('webhook')
    @HttpCode(HttpStatus.OK)
    async handleHeliusPush(
        @Body() transactions: HeliusWebhookPayload,
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

            const safeTransactions = this.normalizeTransactions(transactions);
            const mintAddresses = this.extractMintAddresses(safeTransactions);
            const nativeTransferCount = this.countNativeTransfers(safeTransactions);

            this.logger.log(
                `[HeliusWebhook] Accepted webhook payload: tx=${safeTransactions.length}, mints=${mintAddresses.size}, nativeTransfers=${nativeTransferCount}`,
            );

            void this.processWebhookBackgroundJobs(safeTransactions).catch((error: Error) => {
                this.logger.error(`[HeliusWebhook] Background processing failed: ${error.message}`);
            });

            res.status(HttpStatus.OK);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Helius webhook parsing failed: ${message}`);
            res.status(HttpStatus.OK);
        }
    }

    private async processWebhookBackgroundJobs(transactions: HeliusWebhookTransaction[]): Promise<void> {
        for (const transaction of transactions) {
            try {
                this.queueMintCandidates(transaction);
                await this.processNativeDepositTransaction(transaction);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(
                    `[HeliusWebhook] Failed to process transaction ${transaction.signature}: ${message}`,
                );
            }
        }
    }

    private queueMintCandidates(transaction: HeliusWebhookTransaction): void {
        const mintAddresses = new Set<string>();

        for (const transfer of transaction.tokenTransfers) {
            this.collectMintAddress(transfer, mintAddresses);
        }

        for (const transfer of transaction.events?.tokenTransfers ?? []) {
            this.collectMintAddress(transfer, mintAddresses);
        }

        for (const mintAddress of mintAddresses) {
            void this.scannerService.processNewToken(mintAddress).catch((error: Error) => {
                this.logger.error(
                    `[HeliusWebhook] Failed to queue ${mintAddress}: ${error.message}`,
                );
            });
        }

        if (mintAddresses.size > 0) {
            this.logger.log(
                `[HeliusWebhook] Queued webhook mint(s): ${Array.from(mintAddresses).join(', ')}`,
            );
        }
    }

    private async processNativeDepositTransaction(
        transaction: HeliusWebhookTransaction,
    ): Promise<void> {
        if (!this.isSuccessfulNativeTransfer(transaction)) {
            return;
        }

        const depositBatches = this.groupNativeTransfers(transaction);
        if (depositBatches.length === 0) {
            return;
        }

        for (const depositBatch of depositBatches) {
            try {
                const depositResult = await this.creditWalletDeposit(transaction, depositBatch);
                if (!depositResult) {
                    continue;
                }

                await this.reportingService.sendDepositNotification({
                    targetChatId: depositResult.chatId,
                    walletAddress: depositBatch.walletPublicKey,
                    amountSol: depositResult.amountSol,
                    newBalanceSol: depositResult.newBalanceSol,
                    signature: transaction.signature,
                });

                this.logger.log(
                    `[HeliusWebhook] Deposit credited: chat=${depositResult.chatId} wallet=${depositBatch.walletPublicKey} amountSol=${depositResult.amountSol.toFixed(4)} newBalanceSol=${depositResult.newBalanceSol.toFixed(4)} tx=${transaction.signature}`,
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(
                    `[HeliusWebhook] Deposit handling failed for ${depositBatch.walletPublicKey} (${transaction.signature}): ${message}`,
                );
            }
        }
    }

    private async creditWalletDeposit(
        transaction: HeliusWebhookTransaction,
        depositBatch: NativeDepositBatch,
    ): Promise<DepositLedgerInsertResult | null> {
        const wallet = await this.prismaService.telegramWalletVault.findUnique({
            where: { publicKey: depositBatch.walletPublicKey },
            select: {
                id: true,
                telegramChatId: true,
                publicKey: true,
                balanceSol: true,
                chat: {
                    select: {
                        chatId: true,
                    },
                },
            },
        });

        if (!wallet) {
            return null;
        }

        const amountSol = this.lamportsToSol(depositBatch.amountLamports);
        if (amountSol <= 0) {
            return null;
        }

        try {
            const updatedVault = await this.prismaService.$transaction(async (tx) => {
                await tx.telegramDepositLedger.create({
                    data: {
                        telegramChatId: wallet.telegramChatId,
                        walletPublicKey: wallet.publicKey,
                        signature: transaction.signature,
                        amountSol,
                        slotNumber: transaction.slot,
                        txTimestamp: this.toDateFromTimestamp(transaction.timestamp),
                    },
                });

                return tx.telegramWalletVault.update({
                    where: { publicKey: wallet.publicKey },
                    data: {
                        balanceSol: {
                            increment: amountSol,
                        },
                    },
                    select: {
                        balanceSol: true,
                        chat: {
                            select: {
                                chatId: true,
                            },
                        },
                    },
                });
            });

            return {
                chatId: updatedVault.chat.chatId,
                amountSol,
                newBalanceSol: updatedVault.balanceSol,
            };
        } catch (error) {
            if (this.isUniqueLedgerConflict(error)) {
                this.logger.debug(
                    `[HeliusWebhook] Duplicate deposit ignored for signature=${transaction.signature} wallet=${wallet.publicKey}`,
                );
                return null;
            }

            throw error;
        }
    }

    private isSuccessfulNativeTransfer(transaction: HeliusWebhookTransaction): boolean {
        const type = transaction.type.trim().toUpperCase();
        const status = transaction.status.trim().toUpperCase();
        return type === 'TRANSFER' && status === 'SUCCESS' && this.getNativeTransfers(transaction).length > 0;
    }

    private groupNativeTransfers(transaction: HeliusWebhookTransaction): NativeDepositBatch[] {
        const grouped = new Map<string, number>();

        for (const transfer of this.getNativeTransfers(transaction)) {
            const walletPublicKey = transfer.toUserAccount.trim();
            const amountLamports = this.normalizeLamports(transfer.amount);

            if (!walletPublicKey || amountLamports <= 0) {
                continue;
            }

            grouped.set(walletPublicKey, (grouped.get(walletPublicKey) || 0) + amountLamports);
        }

        return Array.from(grouped.entries()).map(([walletPublicKey, amountLamports]) => ({
            walletPublicKey,
            amountLamports,
        }));
    }

    private getNativeTransfers(transaction: HeliusWebhookTransaction): HeliusNativeTransfer[] {
        return transaction.nativeTransfers ?? transaction.events?.nativeTransfers ?? [];
    }

    private extractMintAddresses(transactions: HeliusWebhookTransaction[]): Set<string> {
        const mintAddresses = new Set<string>();

        for (const transaction of transactions) {
            for (const transfer of transaction.tokenTransfers) {
                this.collectMintAddress(transfer, mintAddresses);
            }

            for (const transfer of transaction.events?.tokenTransfers ?? []) {
                this.collectMintAddress(transfer, mintAddresses);
            }
        }

        return mintAddresses;
    }

    private countNativeTransfers(transactions: HeliusWebhookTransaction[]): number {
        let total = 0;
        for (const transaction of transactions) {
            total += this.getNativeTransfers(transaction).length;
        }
        return total;
    }

    private normalizeTransactions(transactions: HeliusWebhookPayload): HeliusWebhookTransaction[] {
        if (Array.isArray(transactions)) {
            return transactions;
        }

        return [transactions];
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

    private lamportsToSol(lamports: number): number {
        return lamports / 1_000_000_000;
    }

    private normalizeLamports(amount: number): number {
        if (!Number.isFinite(amount)) {
            return 0;
        }

        return Math.trunc(amount);
    }

    private toDateFromTimestamp(timestamp: number): Date {
        return new Date(timestamp * 1000);
    }

    private isUniqueLedgerConflict(error: Error): boolean {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
            return error.code === 'P2002';
        }

        return false;
    }
}
