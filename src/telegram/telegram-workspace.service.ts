import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@solana/web3.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramChat, TelegramChatSetting, TelegramWalletVault } from '@prisma/client';

export interface TelegramChatInput {
    id: string | number;
    type: string;
    title?: string | null;
    username?: string | null;
}

export interface WalletResolutionResult {
    chat: TelegramChat;
    wallet: TelegramWalletVault;
    keypair: Keypair;
    created: boolean;
}

@Injectable()
export class TelegramWorkspaceService {
    private readonly logger = new Logger(TelegramWorkspaceService.name);
    private readonly walletCache = new Map<string, Keypair>();

    constructor(
        private readonly configService: ConfigService,
        private readonly prismaService: PrismaService,
    ) {}

    getAppMode(): 'development' | 'production' {
        const raw = (this.configService.get<string>('APP_MODE') || 'development').toLowerCase();
        return raw === 'production' ? 'production' : 'development';
    }

    isDevelopmentMode(): boolean {
        return this.getAppMode() === 'development';
    }

    getAllowedChatIds(): string[] {
        const raw =
            this.configService.get<string>('TELEGRAM_CHAT_IDS') ||
            this.configService.get<string>('TELEGRAM_CHAT_ID') ||
            '';

        return Array.from(
            new Set(
                raw
                    .split(',')
                    .map((id) => id.trim())
                    .filter(Boolean),
            ),
        );
    }

    isChatAllowed(chatId: string): boolean {
        if (!this.isDevelopmentMode()) return true;
        const allowed = this.getAllowedChatIds();
        if (allowed.length === 0) return false;
        return allowed.includes(chatId);
    }

    async upsertTelegramChat(input: TelegramChatInput): Promise<TelegramChat> {
        const chatId = String(input.id);
        const chatType = this.normalizeChatType(input.type);

        return this.prismaService.telegramChat.upsert({
            where: { chatId },
            create: {
                chatId,
                chatType,
                title: input.title || null,
                username: input.username || null,
                status: 'ACTIVE',
                lastSeenAt: new Date(),
            },
            update: {
                chatType,
                title: input.title || null,
                username: input.username || null,
                status: 'ACTIVE',
                lastSeenAt: new Date(),
            },
        });
    }

    async getChatById(chatId: string) {
        return this.prismaService.telegramChat.findUnique({
            where: { chatId },
            include: {
                walletVault: true,
                settings: true,
            },
        });
    }

    async getActiveChatIds(): Promise<string[]> {
        const rows = await this.prismaService.telegramChat.findMany({
            where: { status: 'ACTIVE' },
            select: { chatId: true },
        });

        return rows.map((row) => row.chatId);
    }

    async ensureWalletForChat(chatId: string): Promise<WalletResolutionResult> {
        const chat = await this.prismaService.telegramChat.findUnique({
            where: { chatId },
            include: { walletVault: true, settings: true },
        });

        if (!chat) {
            throw new Error(`Telegram chat ${chatId} is not registered.`);
        }

        if (chat.walletVault) {
            const keypair = this.decryptWalletVault(chat.walletVault);
            this.walletCache.set(chatId, keypair);
            return {
                chat,
                wallet: chat.walletVault,
                keypair,
                created: false,
            };
        }

        const keypair = Keypair.generate();
        const encrypted = this.encryptSecretKey(keypair.secretKey);

        const wallet = await this.prismaService.telegramWalletVault.create({
            data: {
                telegramChatId: chat.id,
                publicKey: keypair.publicKey.toBase58(),
                encryptedSecretKey: encrypted.ciphertext,
                initializationVector: encrypted.iv,
                authTag: encrypted.authTag,
                keyVersion: encrypted.keyVersion,
            },
        });

        await this.ensureDefaultSettings(chat.id);
        this.walletCache.set(chatId, keypair);

        return {
            chat,
            wallet,
            keypair,
            created: true,
        };
    }

    async getWalletKeypair(chatId: string): Promise<Keypair> {
        if (!chatId) {
            throw new Error('Chat ID is required to resolve a wallet.');
        }

        const cached = this.walletCache.get(chatId);
        if (cached) return cached;

        const chat = await this.prismaService.telegramChat.findUnique({
            where: { chatId },
            include: { walletVault: true },
        });

        if (!chat?.walletVault) {
            throw new Error(`Wallet not connected for chat ${chatId}.`);
        }

        const keypair = this.decryptWalletVault(chat.walletVault);
        this.walletCache.set(chatId, keypair);
        return keypair;
    }

    async getWalletKeypairByChatDbId(chatDbId: number): Promise<Keypair> {
        const chat = await this.prismaService.telegramChat.findUnique({
            where: { id: chatDbId },
            include: { walletVault: true },
        });

        if (!chat?.walletVault) {
            throw new Error(`Wallet not connected for chat record ${chatDbId}.`);
        }

        const keypair = this.decryptWalletVault(chat.walletVault);
        this.walletCache.set(chat.chatId, keypair);
        return keypair;
    }

    async getWalletPublicKey(chatId: string): Promise<string> {
        return (await this.getWalletKeypair(chatId)).publicKey.toBase58();
    }

    async getChatSettings(chatId: string): Promise<TelegramChatSetting> {
        const chat = await this.prismaService.telegramChat.findUnique({
            where: { chatId },
            include: { settings: true },
        });

        if (!chat) {
            throw new Error(`Telegram chat ${chatId} is not registered.`);
        }

        if (chat.settings) return chat.settings;
        return this.ensureDefaultSettings(chat.id);
    }

    async updateChatSettings(
        chatId: string,
        updates: Partial<
            Pick<TelegramChatSetting, 'totalSlots' | 'positionSizeUsd' | 'slippageOnSol' | 'dryRun'>
        >,
    ): Promise<TelegramChatSetting> {
        const chat = await this.prismaService.telegramChat.findUnique({
            where: { chatId },
            include: { settings: true },
        });

        if (!chat) {
            throw new Error(`Telegram chat ${chatId} is not registered.`);
        }

        return this.prismaService.telegramChatSetting.upsert({
            where: { telegramChatId: chat.id },
            create: {
                telegramChatId: chat.id,
                totalSlots: updates.totalSlots ?? 2,
                positionSizeUsd: updates.positionSizeUsd ?? 5,
                slippageOnSol: updates.slippageOnSol ?? 0.005,
                dryRun: updates.dryRun ?? this.getDefaultDryRun(),
            },
            update: {
                ...updates,
            },
        });
    }

    async getConnectedWalletCount(): Promise<number> {
        return this.prismaService.telegramWalletVault.count();
    }

    private async ensureDefaultSettings(chatId: number): Promise<TelegramChatSetting> {
        return this.prismaService.telegramChatSetting.upsert({
            where: { telegramChatId: chatId },
            create: {
                telegramChatId: chatId,
                totalSlots: 2,
                positionSizeUsd: 5,
                slippageOnSol: 0.005,
                dryRun: this.getDefaultDryRun(),
            },
            update: {},
        });
    }

    private normalizeChatType(type: string) {
        const normalized = type.toLowerCase();
        switch (normalized) {
            case 'private':
                return 'PRIVATE';
            case 'supergroup':
                return 'SUPERGROUP';
            case 'channel':
                return 'CHANNEL';
            case 'group':
            default:
                return 'GROUP';
        }
    }

    private getEncryptionKey(): Buffer {
        const rawKey =
            this.configService.get<string>('WALLET_ENCRYPTION_KEY') ||
            this.configService.get<string>('ENCRYPTION_KEY') ||
            '';

        if (!rawKey || rawKey.includes('your-wallet-encryption-key')) {
            throw new Error('WALLET_ENCRYPTION_KEY is required for wallet vault encryption.');
        }

        return createHash('sha256').update(rawKey).digest();
    }

    private getDefaultDryRun(): boolean {
        return this.configService.get<string>('DRY_RUN') === 'true';
    }

    private encryptSecretKey(secretKey: Uint8Array): {
        ciphertext: string;
        iv: string;
        authTag: string;
        keyVersion: number;
    } {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
        const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
        const authTag = cipher.getAuthTag();

        return {
            ciphertext: encrypted.toString('base64'),
            iv: iv.toString('base64'),
            authTag: authTag.toString('base64'),
            keyVersion: 1,
        };
    }

    private decryptWalletVault(walletVault: TelegramWalletVault): Keypair {
        const key = this.getEncryptionKey();
        const decipher = createDecipheriv(
            'aes-256-gcm',
            key,
            Buffer.from(walletVault.initializationVector, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(walletVault.authTag, 'base64'));

        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(walletVault.encryptedSecretKey, 'base64')),
            decipher.final(),
        ]);

        return Keypair.fromSecretKey(new Uint8Array(decrypted));
    }

}
