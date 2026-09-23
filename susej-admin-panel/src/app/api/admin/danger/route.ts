import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { getActiveAdmin, getClientIp } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

// NEVER touch, in any area: Admin, AppSetting (except otp: keys in sessions),
// AuditLog, Category, Coupon, SubscriptionPlan, Subscriber, LoyaltyUser,
// Transaction, LedgerEntry, WalletTransaction, Withdrawal, CommissionSetting,
// NotificationTemplate, PasswordResetToken.
// Rule: money books append-only, config/trail preserved. Demo purges wipe
// disposable demo rows only — the money trail and platform config survive.

type Area =
  | "orders"
  | "catalog"
  | "promotions"
  | "community"
  | "sellers"
  | "users"
  | "sessions"
  | "media"
  | "full";

const AREAS: Area[] = [
  "orders",
  "catalog",
  "promotions",
  "community",
  "sellers",
  "users",
  "sessions",
  "media",
  "full",
];

// Prisma delegate keys (camelCase) per area. Order matters inside sellers/users
// (children before parents).
const AREA_MODELS: Record<Exclude<Area, "media" | "full">, string[]> = {
  orders: ["order", "shipment", "refund", "dispute", "booking", "auction", "auctionBid"],
  catalog: ["product", "post", "postLike", "postComment", "review", "bundle", "foodHubItem"],
  promotions: [
    "topSeller",
    "hotDeal",
    "featuredPost",
    "spotlight",
    "promotionPurchase",
    "storefrontBanner",
  ],
  community: [
    "community",
    "communityMessage",
    "poll",
    "pollVote",
    "broadcast",
    "liveStream",
    "reel",
    "reelLike",
    "story",
    "hashtag",
    "chatThread",
    "chatMessage",
    "message",
    "block",
    "blockedUser",
  ],
  sellers: ["sellerDocument", "sellerAuditLog", "seller"],
  users: [
    "addressBookEntry",
    "paymentMethod",
    "priceWatch",
    "follow",
    "userNotification",
    "supportTicket",
    "reportedUser",
    "reportedProduct",
    "reportedMessage",
    "reportedComment",
    "user",
  ],
  sessions: ["appSession", "appSettingOtp"],
};

const FULL_ORDER: Exclude<Area, "full" | "media">[] = [
  "orders",
  "catalog",
  "promotions",
  "community",
  "sellers",
  "users",
  "sessions",
];

const PHRASES: Record<Area, string> = {
  orders: "DELETE ORDERS",
  catalog: "DELETE CATALOG",
  promotions: "DELETE PROMOTIONS",
  community: "DELETE COMMUNITY",
  sellers: "DELETE SELLERS",
  users: "DELETE USERS FOREVER",
  sessions: "DELETE SESSIONS",
  media: "DELETE MEDIA",
  full: "DELETE EVERYTHING FOREVER",
};

function normalizeRole(role: unknown): string {
  return String(role ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "_");
}

function isSuperRole(role: unknown): boolean {
  const r = normalizeRole(role);
  return r === "super_admin" || r === "superadmin" || r === "owner";
}

interface Delegate {
  count: (args?: unknown) => Promise<number>;
  deleteMany: (args?: unknown) => Promise<{ count: number }>;
}

function delegate(prisma: unknown, key: string): Delegate | null {
  const db = prisma as unknown as Record<string, Delegate | undefined>;
  const d = db[key];
  if (!d || typeof d.count !== "function" || typeof d.deleteMany !== "function") return null;
  return d;
}

async function safeCount(prisma: unknown, model: string): Promise<number> {
  // sessions'area pseudo-model appSettingOtp counts otp: keys only.
  if (model === "appSettingOtp") {
    const d = delegate(prisma, "appSetting");
    if (!d) return 0;
    try {
      return await d.count({ where: { key: { startsWith: "otp:" } } });
    } catch {
      return 0;
    }
  }
  const d = delegate(prisma, model);
  if (!d) return 0;
  try {
    return await d.count();
  } catch {
    return 0;
  }
}

async function areaCount(prisma: unknown, area: Exclude<Area, "full" | "media">): Promise<number> {
  let total = 0;
  for (const model of AREA_MODELS[area]) {
    total += await safeCount(prisma, model);
  }
  return total;
}

async function allCounts(prisma: unknown): Promise<Record<string, number>> {
  const [orders, catalog, promotions, community, sellers, users, sessions] = await Promise.all([
    areaCount(prisma, "orders"),
    areaCount(prisma, "catalog"),
    areaCount(prisma, "promotions"),
    areaCount(prisma, "community"),
    areaCount(prisma, "sellers"),
    areaCount(prisma, "users"),
    areaCount(prisma, "sessions"),
  ]);
  // sessions = AppSession count + AppSetting count where key startsWith 'otp:'.
  // media has no db rows (Cloudinary only) — count is always 0 here.
  return { orders, catalog, promotions, community, sellers, users, sessions, media: 0 };
}

interface ModelResult {
  model: string;
  deleted?: number;
  error?: string;
  skipped?: boolean;
}

async function purgeModels(prisma: unknown, models: string[]): Promise<ModelResult[]> {
  const out: ModelResult[] = [];
  for (const model of models) {
    // otp: keys only — the rest of AppSetting (config) is never touched.
    if (model === "appSettingOtp") {
      const d = delegate(prisma, "appSetting");
      if (!d) {
        out.push({ model: "AppSetting(otp:)", error: "delegate missing" });
        continue;
      }
      try {
        const r = await d.deleteMany({ where: { key: { startsWith: "otp:" } } });
        out.push({ model: "AppSetting(otp:)", deleted: r.count });
      } catch (e) {
        out.push({ model: "AppSetting(otp:)", error: e instanceof Error ? e.message : "delete failed" });
      }
      continue;
    }
    const d = delegate(prisma, model);
    if (!d) {
      out.push({ model, error: "delegate missing" });
      continue;
    }
    const label = model.charAt(0).toUpperCase() + model.slice(1);
    try {
      const r = await d.deleteMany({});
      out.push({ model: label, deleted: r.count });
    } catch (e) {
      out.push({ model: label, error: e instanceof Error ? e.message : "delete failed" });
    }
  }
  return out;
}

async function purgeMedia(): Promise<ModelResult[]> {
  // NO db — Cloudinary prefixes only. Skip gracefully when unconfigured.
  if (!process.env.CLOUDINARY_URL) {
    return [{ model: "Cloudinary(susej/, susej-probe/)", skipped: true, error: "CLOUDINARY_URL unset — nothing deleted" }];
  }
  const out: ModelResult[] = [];
  try {
    const { v2: cloudinary } = await import("cloudinary");
    for (const prefix of ["susej/", "susej-probe/"]) {
      try {
        const res = (await cloudinary.api.delete_resources_by_prefix(prefix)) as unknown as {
          deleted?: Record<string, string>;
        };
        const n = res && typeof res === "object" && res.deleted ? Object.keys(res.deleted).length : 0;
        out.push({ model: `Cloudinary(${prefix})`, deleted: n });
      } catch (e) {
        out.push({
          model: `Cloudinary(${prefix})`,
          error: e instanceof Error ? e.message : "cloudinary delete failed",
        });
      }
    }
  } catch (e) {
    out.push({
      model: "Cloudinary",
      error: e instanceof Error ? e.message : "cloudinary unavailable",
    });
  }
  return out;
}

async function purgeArea(prisma: unknown, area: Exclude<Area, "full">): Promise<ModelResult[]> {
  if (area === "media") return purgeMedia();
  // AppSession deleteMany wipes every device session — forces every device to
  // re-login on next request. Said plainly in the UI copy too.
  return purgeModels(prisma, AREA_MODELS[area]);
}

export async function GET(request: NextRequest) {
  try {
    const admin = await getActiveAdmin(request).catch(() => null);
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const prisma = await getPrisma();
    if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    const counts = await allCounts(prisma);
    return NextResponse.json({ counts, isSuper: isSuperRole(admin.role) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Danger counts failed" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = await getActiveAdmin(request).catch(() => null);
    if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const ip = getClientIp(request);
    const super_ = isSuperRole(admin.role);
    let body: { area?: unknown; phrase?: unknown };
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const area = String(body.area ?? "").trim().toLowerCase() as Area;
    const phrase = String(body.phrase ?? "");

    if (!super_) {
      void writeAudit({
        action: "danger.purge",
        entity: String(body.area ?? "unknown"),
        details: `denied: ${admin.loginId} lacks super_admin`,
        adminName: admin.loginId,
        ip,
      });
      return NextResponse.json({ error: "Super Admin only" }, { status: 403 });
    }
    if (!AREAS.includes(area)) {
      void writeAudit({
        action: "danger.purge",
        entity: String(body.area ?? "unknown"),
        details: `validation failed: unknown area "${String(body.area ?? "")}"`,
        adminName: admin.loginId,
        ip,
      });
      return NextResponse.json({ error: "Unknown area" }, { status: 400 });
    }
    if (phrase !== PHRASES[area]) {
      void writeAudit({
        action: "danger.purge",
        entity: area,
        details: `validation failed: wrong phrase for ${area}`,
        adminName: admin.loginId,
        ip,
      });
      return NextResponse.json({ error: `Type ${PHRASES[area]} to confirm.` }, { status: 400 });
    }

    const prisma = await getPrisma();
    if (!prisma) {
      void writeAudit({
        action: "danger.purge",
        entity: area,
        details: "failed: database unavailable",
        adminName: admin.loginId,
        ip,
      });
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    let results: ModelResult[];
    if (area === "full") {
      results = [];
      // full: orders -> catalog -> promotions -> community -> sellers -> users
      // -> sessions -> media, in that order (children before parents inside
      // each area; media last since it is remote, not db).
      for (const a of FULL_ORDER) {
        const part = await purgeArea(prisma, a);
        results.push(...part);
      }
      results.push(...(await purgeMedia()));
    } else {
      results = await purgeArea(prisma, area);
    }
    const totalDeleted = results.reduce((n, r) => n + (r.deleted ?? 0), 0);
    const failures = results.filter((r) => r.error && !r.skipped).length;
    void writeAudit({
      action: "danger.purge",
      entity: area,
      details: JSON.stringify({ totalDeleted, failures, results }),
      adminName: admin.loginId,
      ip,
    });
    return NextResponse.json({ ok: true, area, results, totalDeleted, failures });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Danger purge failed" },
      { status: 500 }
    );
  }
}
