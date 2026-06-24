-- Add whale-mode social and narrative persistence fields to Watchlist.
ALTER TABLE "Watchlist"
ADD COLUMN IF NOT EXISTS "tokenName" TEXT,
ADD COLUMN IF NOT EXISTS "hasWebsite" BOOLEAN,
ADD COLUMN IF NOT EXISTS "hasTwitter" BOOLEAN,
ADD COLUMN IF NOT EXISTS "hasTelegram" BOOLEAN,
ADD COLUMN IF NOT EXISTS "isDexPaidUpdated" BOOLEAN,
ADD COLUMN IF NOT EXISTS "isCommunityTakeover" BOOLEAN;
