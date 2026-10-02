-- Schema parity for code paths that read these fields unconditionally.
-- STAGED IN REPOSITORY ONLY — NOT APPLIED TO LIVE NEON.
-- Apply with prisma migrate deploy after a Neon backup, before deploying code.
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "deliveryMode" TEXT;
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "shippingFee" DOUBLE PRECISION;
ALTER TABLE "Reel" ADD COLUMN IF NOT EXISTS "creatorUsername" TEXT;
ALTER TABLE "Reel" ADD COLUMN IF NOT EXISTS "mediaUrl" TEXT;
ALTER TABLE "Reel" ADD COLUMN IF NOT EXISTS "caption" TEXT;
ALTER TABLE "Bundle" ADD COLUMN IF NOT EXISTS "items" JSONB;
ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "pinnedUntil" TIMESTAMP(3);
ALTER TABLE "ChatThread" ADD COLUMN IF NOT EXISTS "pinnedBy" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "offerAmount" DOUBLE PRECISION;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "offerProductId" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "offerProductName" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "offerStatus" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User"
    WHERE "phone" IS NOT NULL
    GROUP BY "phone"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate User.phone values exist; resolve identity collisions before applying the unique index';
  END IF;
END $$;
DO $$
DECLARE
  phone_key_is_valid BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_index AS index_meta
    JOIN pg_class AS index_class ON index_class.oid = index_meta.indexrelid
    JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
    JOIN pg_class AS table_class
      ON table_class.relnamespace = namespace.oid
     AND table_class.relname = 'User'
    WHERE namespace.nspname = 'public'
      AND index_class.relname = 'User_phone_key'
      AND index_meta.indisunique
      AND index_meta.indisvalid
      AND index_meta.indnkeyatts = 1
      AND index_meta.indpred IS NULL
      AND index_meta.indexprs IS NULL
      AND index_meta.indkey::smallint[] = ARRAY[
        (
          SELECT attribute.attnum::smallint
          FROM pg_attribute AS attribute
          WHERE attribute.attrelid = table_class.oid
            AND attribute.attname = 'phone'
            AND NOT attribute.attisdropped
        )
      ]::smallint[]
  ) INTO phone_key_is_valid;

  IF NOT phone_key_is_valid THEN
    IF EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = '"User"'::regclass
        AND conname = 'User_phone_key'
        AND contype = 'u'
    ) THEN
      ALTER TABLE "User" DROP CONSTRAINT "User_phone_key";
    ELSE
      DROP INDEX IF EXISTS "User_phone_key";
    END IF;
  END IF;
END $$;
DROP INDEX IF EXISTS "User_phone_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "User_phone_key" ON "User"("phone");

-- Wallet title idempotency is required by checkout, promotion, top-up, and
-- payout lanes. Preflight deliberately aborts instead of deleting money rows:
-- resolve every duplicate (username, title) pair before applying this file.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "WalletTransaction"
    GROUP BY "username", "title"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate WalletTransaction(username,title) values exist; reconcile ledger rows before applying the unique index';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "WalletTransaction_username_title_key"
  ON "WalletTransaction"("username", "title");

CREATE TABLE IF NOT EXISTS "Spotlight" (
    "id" TEXT NOT NULL,
    "postId" TEXT,
    "productId" TEXT,
    "sellerId" TEXT NOT NULL,
    "sellerName" TEXT NOT NULL,
    "sellerLogo" TEXT,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT,
    "position" INTEGER NOT NULL DEFAULT 1,
    "isPinned" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startDate" TEXT NOT NULL DEFAULT '',
    "endDate" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Spotlight_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Spotlight_sellerId_idx" ON "Spotlight"("sellerId");
CREATE INDEX IF NOT EXISTS "Spotlight_postId_idx" ON "Spotlight"("postId");
CREATE INDEX IF NOT EXISTS "Spotlight_productId_idx" ON "Spotlight"("productId");
CREATE INDEX IF NOT EXISTS "Spotlight_status_endDate_idx" ON "Spotlight"("status", "endDate");
