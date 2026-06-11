-- Create enums
DO $$
BEGIN
    CREATE TYPE "TelegramChatType" AS ENUM ('PRIVATE', 'GROUP', 'SUPERGROUP', 'CHANNEL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
    CREATE TYPE "TelegramChatStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create Telegram chat registry
CREATE TABLE IF NOT EXISTS "TelegramChat" (
    "id" SERIAL NOT NULL,
    "chatId" TEXT NOT NULL,
    "chatType" "TelegramChatType" NOT NULL,
    "title" TEXT,
    "username" TEXT,
    "status" "TelegramChatStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelegramChat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelegramChat_chatId_key" ON "TelegramChat"("chatId");
CREATE INDEX IF NOT EXISTS "TelegramChat_status_chatType_idx" ON "TelegramChat"("status", "chatType");
CREATE INDEX IF NOT EXISTS "TelegramChat_lastSeenAt_idx" ON "TelegramChat"("lastSeenAt");

-- Create wallet vault
CREATE TABLE IF NOT EXISTS "TelegramWalletVault" (
    "id" SERIAL NOT NULL,
    "telegramChatId" INTEGER NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedSecretKey" TEXT NOT NULL,
    "initializationVector" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelegramWalletVault_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelegramWalletVault_telegramChatId_key" ON "TelegramWalletVault"("telegramChatId");
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramWalletVault_publicKey_key" ON "TelegramWalletVault"("publicKey");

-- Create settings
CREATE TABLE IF NOT EXISTS "TelegramChatSetting" (
    "id" SERIAL NOT NULL,
    "telegramChatId" INTEGER NOT NULL,
    "totalSlots" INTEGER NOT NULL DEFAULT 2,
    "positionSizeUsd" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "slippageOnSol" DOUBLE PRECISION NOT NULL DEFAULT 0.005,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelegramChatSetting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelegramChatSetting_telegramChatId_key" ON "TelegramChatSetting"("telegramChatId");

-- Link trade to chat
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "telegramChatId" INTEGER;
CREATE INDEX IF NOT EXISTS "Trade_telegramChatId_status_mode_idx" ON "Trade"("telegramChatId", "status", "mode");

-- Foreign keys
DO $$
BEGIN
    ALTER TABLE "TelegramWalletVault"
        ADD CONSTRAINT "TelegramWalletVault_telegramChatId_fkey"
        FOREIGN KEY ("telegramChatId") REFERENCES "TelegramChat"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
    ALTER TABLE "TelegramChatSetting"
        ADD CONSTRAINT "TelegramChatSetting_telegramChatId_fkey"
        FOREIGN KEY ("telegramChatId") REFERENCES "TelegramChat"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
    ALTER TABLE "Trade"
        ADD CONSTRAINT "Trade_telegramChatId_fkey"
        FOREIGN KEY ("telegramChatId") REFERENCES "TelegramChat"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
