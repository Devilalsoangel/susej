-- Sep21 one-shot: whole-rupee money (Float -> INTEGER).
-- STAGED, NOT APPLIED. Apply ONLY with an explicit db-push call AND a fresh
-- Neon backup first: this rewrites 15 live money tables (ROUND halves up).
-- No schema.prisma change ships with it (generated client reads numbers
-- either way; all writers already Math.round). After deploy, flip the
-- schema types to Int + regenerate for compile-time paise safety.
-- Coupon values like 99.99 become 100 (documented 1-paise policy change).
-- Backfill audit first: SELECT code, value FROM "Coupon" WHERE value != ROUND(value);
DO $$ BEGIN
  ALTER TABLE "Product" ALTER COLUMN "price" TYPE INTEGER USING (ROUND("price")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Product.price: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "Order" ALTER COLUMN "amount" TYPE INTEGER USING (ROUND("amount")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Order.amount: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "Transaction" ALTER COLUMN "amount" TYPE INTEGER USING (ROUND("amount")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Transaction.amount: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "LedgerEntry" ALTER COLUMN "amount" TYPE INTEGER USING (ROUND("amount")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'LedgerEntry.amount: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "GatewayLog" ALTER COLUMN "amount" TYPE INTEGER USING (ROUND("amount")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'GatewayLog.amount: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "Coupon" ALTER COLUMN "value" TYPE INTEGER USING (ROUND("value")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Coupon.value: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "HotDeal" ALTER COLUMN "originalPrice" TYPE INTEGER USING (ROUND("originalPrice")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'HotDeal.originalPrice: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "HotDeal" ALTER COLUMN "discountedPrice" TYPE INTEGER USING (ROUND("discountedPrice")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'HotDeal.discountedPrice: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "PromotionPurchase" ALTER COLUMN "amountPaid" TYPE INTEGER USING (ROUND("amountPaid")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PromotionPurchase.amountPaid: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "PromotionPurchase" ALTER COLUMN "discountedPrice" TYPE INTEGER USING (ROUND("discountedPrice")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PromotionPurchase.discountedPrice: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "PromotionPurchase" ALTER COLUMN "originalPrice" TYPE INTEGER USING (ROUND("originalPrice")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'PromotionPurchase.originalPrice: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "Post" ALTER COLUMN "price" TYPE INTEGER USING (ROUND("price")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Post.price: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "Bundle" ALTER COLUMN "price" TYPE INTEGER USING (ROUND("price")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Bundle.price: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "FoodHubItem" ALTER COLUMN "price" TYPE INTEGER USING (ROUND("price")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'FoodHubItem.price: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "Booking" ALTER COLUMN "price" TYPE INTEGER USING (ROUND("price")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Booking.price: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "Dispute" ALTER COLUMN "amount" TYPE INTEGER USING (ROUND("amount")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Dispute.amount: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "Refund" ALTER COLUMN "amount" TYPE INTEGER USING (ROUND("amount")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Refund.amount: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "Withdrawal" ALTER COLUMN "amount" TYPE INTEGER USING (ROUND("amount")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Withdrawal.amount: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "Withdrawal" ALTER COLUMN "fee" TYPE INTEGER USING (ROUND("fee")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'Withdrawal.fee: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "WalletTransaction" ALTER COLUMN "amount" TYPE INTEGER USING (ROUND("amount")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'WalletTransaction.amount: %', SQLERRM; END $$;
DO $$ BEGIN
  ALTER TABLE "AuctionBid" ALTER COLUMN "amount" TYPE INTEGER USING (ROUND("amount")::INTEGER);
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'AuctionBid.amount: %', SQLERRM; END $$;
