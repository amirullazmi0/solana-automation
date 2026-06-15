-- Create enums
DO $$
BEGIN
    CREATE TYPE "WithdrawalAmountMode" AS ENUM ('PERCENT', 'USD');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
    CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create withdrawal history table
CREATE TABLE IF NOT EXISTS "TelegramWithdrawal" (
    "id" SERIAL NOT NULL,
    "telegramChatId" INTEGER NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "amountMode" "WithdrawalAmountMode" NOT NULL,
    "requestedAmount" DOUBLE PRECISION NOT NULL,
    "amountTransferredSol" DOUBLE PRECISION,
    "balanceBeforeSol" DOUBLE PRECISION,
    "balanceAfterSol" DOUBLE PRECISION,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelegramWithdrawal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TelegramWithdrawal_telegramChatId_createdAt_idx" ON "TelegramWithdrawal"("telegramChatId", "createdAt");
CREATE INDEX IF NOT EXISTS "TelegramWithdrawal_telegramChatId_status_idx" ON "TelegramWithdrawal"("telegramChatId", "status");

-- Foreign keys
DO $$
BEGIN
    ALTER TABLE "TelegramWithdrawal"
        ADD CONSTRAINT "TelegramWithdrawal_telegramChatId_fkey"
        FOREIGN KEY ("telegramChatId") REFERENCES "TelegramChat"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
