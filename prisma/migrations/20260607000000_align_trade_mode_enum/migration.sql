DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TradeMode') THEN
        CREATE TYPE "TradeMode" AS ENUM ('LIVE', 'PAPER');
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'Trade'
          AND column_name = 'mode'
          AND udt_name <> 'TradeMode'
    ) THEN
        ALTER TABLE "Trade" ALTER COLUMN "mode" DROP DEFAULT;
        ALTER TABLE "Trade"
            ALTER COLUMN "mode" TYPE "TradeMode"
            USING ("mode"::text::"TradeMode");
        ALTER TABLE "Trade" ALTER COLUMN "mode" SET DEFAULT 'LIVE';
    END IF;
END $$;
