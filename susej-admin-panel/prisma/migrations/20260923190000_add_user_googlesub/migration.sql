-- Repair drift: schema.prisma declares User.googleSub @unique but no migration
-- ever created it, so every prisma.user.* read on prod threw
-- "column User.googleSub does not exist" (500 on sign-in check + verify).
-- Minimal repair only: nullable column + unique index. Legacy tables and
-- other drift items are deliberately untouched here.
ALTER TABLE "User" ADD COLUMN "googleSub" TEXT;

CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");
