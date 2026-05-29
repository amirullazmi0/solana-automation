ALTER TABLE "Trade" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'LIVE';

-- Optional backfill: if you ever stored simulated trades before introducing mode,
-- you can reclassify them based on buyTxHash convention.
-- UPDATE "Trade" SET "mode" = 'PAPER' WHERE "buyTxHash" LIKE 'simulated_tx_%';
