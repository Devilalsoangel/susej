import { NextRequest, NextResponse } from "next/server";
import { checkAppKeyAsync, unauthorized } from "@/lib/promotions/api-auth";
import { getPrisma } from "@/lib/db";
import { cacheKey, cachedRead } from "@/lib/cache";
import {
  PROMOTION_PACKAGES,
  applyPriceOverrides,
  getChatPinPrice,
  DEFAULT_CHAT_PIN,
} from "@/lib/promotions/catalog";

/**
 * Public marketplace config for the mobile app (x-app-key guarded).
 * The app pulls live commission / fees / promo catalog from the admin DB so
 * seller-facing numbers (wallet commission, payout fees) always match the
 * admin Commission & Fees page instead of hardcoded mirrors.
 */

const FALLBACK = {
  commissionRate: 0.08,
  listingFee: 0,
  payoutFee: 20,
  categoryOverrides: [] as { category: string; rate: number }[],
};

/** The DB stores rates as whole percents (8 = 8%, 0.5 = 0.5%); the app expects fractions (0.08, 0.005). */
function asRate(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n / 100, 1);
}

export async function GET(request: NextRequest) {
  if (!await checkAppKeyAsync(request)) return unauthorized();

  const payload = await cachedRead(cacheKey("config"), async () => {
    let commission = FALLBACK;
    let priceOverrides: Record<string, unknown> | null = null;
    const prisma = await getPrisma();
    if (prisma) {
      try {
        const [row, setting] = await Promise.all([
          prisma.commissionSetting.findUnique({ where: { id: "global" } }),
          prisma.appSetting.findUnique({ where: { key: "promoPrices" } }),
        ]);
        if (row) {
          const overrides = Array.isArray(row.categoryOverrides)
            ? (row.categoryOverrides as { category?: string; rate?: number }[])
                .filter((o) => o && typeof o.category === "string")
                .map((o) => ({ category: o.category as string, rate: Number(o.rate) || 0 }))
            : [];
          commission = {
            commissionRate: asRate(Number(row.commissionRate) || FALLBACK.commissionRate),
            listingFee: Number(row.listingFee) || FALLBACK.listingFee,
            payoutFee: Number(row.payoutFee) || FALLBACK.payoutFee,
            categoryOverrides: overrides.map((o) => ({ category: o.category, rate: asRate(o.rate) })),
          };
        }
        const value = setting?.value;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          priceOverrides = value as Record<string, unknown>;
        }
      } catch {}
    }

    const packages = applyPriceOverrides(priceOverrides);
    return {
      commission,
      promotions: packages.map((p) => ({
        id: p.id,
        kind: p.kind,
        name: p.name,
        description: p.description,
        price: p.price,
        days: p.durationDays,
      })),
      chatPin: {
        price: getChatPinPrice(priceOverrides),
        days: DEFAULT_CHAT_PIN.days,
      },
    };
  }, { freshMs: 30_000, staleMs: 300_000 });

  return NextResponse.json(payload);
}