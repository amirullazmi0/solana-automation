-- Add per-chat dry run toggle
ALTER TABLE "TelegramChatSetting"
ADD COLUMN IF NOT EXISTS "dryRun" BOOLEAN NOT NULL DEFAULT true;
