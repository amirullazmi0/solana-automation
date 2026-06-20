ALTER TABLE "TelegramWalletVault"
    ADD COLUMN IF NOT EXISTS "balanceSol" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "TelegramDepositLedger" (
    "id" SERIAL NOT NULL,
    "telegramChatId" INTEGER NOT NULL,
    "walletPublicKey" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "amountSol" DOUBLE PRECISION NOT NULL,
    "slotNumber" INTEGER,
    "txTimestamp" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramDepositLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TelegramDepositLedger_signature_walletPublicKey_key"
    ON "TelegramDepositLedger"("signature", "walletPublicKey");

CREATE INDEX IF NOT EXISTS "TelegramDepositLedger_telegramChatId_createdAt_idx"
    ON "TelegramDepositLedger"("telegramChatId", "createdAt");

CREATE INDEX IF NOT EXISTS "TelegramDepositLedger_walletPublicKey_idx"
    ON "TelegramDepositLedger"("walletPublicKey");

DO $$
BEGIN
    ALTER TABLE "TelegramDepositLedger"
        ADD CONSTRAINT "TelegramDepositLedger_telegramChatId_fkey"
        FOREIGN KEY ("telegramChatId") REFERENCES "TelegramChat"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
