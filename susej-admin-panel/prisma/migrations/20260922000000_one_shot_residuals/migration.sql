-- Sep21 one-shot residuals. STAGED, NOT APPLIED (needs explicit `prisma migrate deploy`
-- against Neon + deploy; every code path tolerates the pre-migration DB).
-- Order durable facts
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'order';
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "bookingDate" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "bookingTime" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryFee" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "discount" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "promoCode" TEXT NOT NULL DEFAULT '';
-- Dispute stable identity
ALTER TABLE "Dispute" ADD COLUMN IF NOT EXISTS "buyerUsername" TEXT;
ALTER TABLE "Dispute" ADD COLUMN IF NOT EXISTS "sellerUsername" TEXT;
-- User blocks (server enforcement)
CREATE TABLE IF NOT EXISTS "Block" (
    "id" TEXT NOT NULL,
    "blockerUsername" TEXT NOT NULL,
    "blockedUsername" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Block_blockerUsername_blockedUsername_key" ON "Block"("blockerUsername", "blockedUsername");
CREATE INDEX IF NOT EXISTS "Block_blockedUsername_idx" ON "Block"("blockedUsername");
-- Reel likes (toggle truth)
CREATE TABLE IF NOT EXISTS "ReelLike" (
    "id" TEXT NOT NULL,
    "reelId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReelLike_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReelLike_reelId_username_key" ON "ReelLike"("reelId", "username");
CREATE INDEX IF NOT EXISTS "ReelLike_reelId_idx" ON "ReelLike"("reelId");
-- Session hash-at-rest
ALTER TABLE "AppSession" ADD COLUMN IF NOT EXISTS "tokenHash" TEXT;
ALTER TABLE "AppSession" ADD COLUMN IF NOT EXISTS "last4" TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS "AppSession_tokenHash_key" ON "AppSession"("tokenHash");
-- Payout actual fee
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "fee" DOUBLE PRECISION NOT NULL DEFAULT -1;
-- Bundle owner identity
ALTER TABLE "Bundle" ADD COLUMN IF NOT EXISTS "sellerUsername" TEXT;
-- Shop profile
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "tagline" TEXT;
ALTER TABLE "Seller" ADD COLUMN IF NOT EXISTS "hours" TEXT;
-- Price watches
CREATE TABLE IF NOT EXISTS "PriceWatch" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "priceAtWatch" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PriceWatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PriceWatch_username_listingId_key" ON "PriceWatch"("username", "listingId");
CREATE INDEX IF NOT EXISTS "PriceWatch_listingId_idx" ON "PriceWatch"("listingId");
-- Community polls (shared votes)
CREATE TABLE IF NOT EXISTS "Poll" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Poll_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Poll_communityId_idx" ON "Poll"("communityId");
CREATE TABLE IF NOT EXISTS "PollVote" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PollVote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PollVote_pollId_username_key" ON "PollVote"("pollId", "username");
CREATE INDEX IF NOT EXISTS "PollVote_pollId_idx" ON "PollVote"("pollId");
