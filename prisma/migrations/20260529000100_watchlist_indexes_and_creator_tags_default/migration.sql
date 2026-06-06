-- Watchlist indexes to support scanner radar queries and cleanup jobs
CREATE INDEX "Watchlist_status_lastCheckedAt_idx" ON "Watchlist"("status", "lastCheckedAt");
CREATE INDEX "Watchlist_createdAt_status_idx" ON "Watchlist"("createdAt", "status");
CREATE INDEX "Watchlist_pairCreatedAt_createdAt_idx" ON "Watchlist"("pairCreatedAt", "createdAt");

-- Ensure CreatorProfile.tags has a default for safer inserts
ALTER TABLE "CreatorProfile" ALTER COLUMN "tags" SET DEFAULT ARRAY[]::TEXT[];

