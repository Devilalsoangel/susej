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
  // media has no db rows (Cloudinary only) — the GET overrides this 0 with
  // the live Admin API total below.
  return { orders, catalog, promotions, community, sellers, users, sessions, media: 0 };
}

// ---- Cloudinary media (Admin API; the db holds no media rows) ----

type MediaScope = "demo" | "app" | "other";

interface MediaAsset {
  public_id: string;
  secure_url: string;
  bytes: number;
  width: number;
  height: number;
  created_at: string;
  folder: string;
  scope: MediaScope;
}

// Minimal structural view of the Cloudinary Admin API surface we use — cast
// from the real client via unknown so a client version bump cannot silently
// widen what we call.
interface CloudinaryAdminApi {
  resources: (opts: {
    type: string;
    prefix: string;
    max_results: number;
    next_cursor?: string;
  }) => Promise<unknown>;
  delete_resources: (publicIds: string[]) => Promise<unknown>;
}

async function cloudinaryAdmin(): Promise<CloudinaryAdminApi> {
  const { v2: cloudinary } = await import("cloudinary");
  return cloudinary.api as unknown as CloudinaryAdminApi;
}

function mediaScope(publicId: string): MediaScope {
  if (publicId.startsWith("susej-probe/")) return "demo";
  if (publicId.startsWith("susej/")) return "app";
  return "other";
}

function toMediaAsset(item: unknown): MediaAsset | null {
  if (typeof item !== "object" || item === null) return null;
  const v = item as Record<string, unknown>;
  const public_id = typeof v.public_id === "string" ? v.public_id : "";
  if (!public_id) return null;
  return {
    public_id,
    secure_url: typeof v.secure_url === "string" ? v.secure_url : "",
    bytes: typeof v.bytes === "number" ? v.bytes : 0,
    width: typeof v.width === "number" ? v.width : 0,
    height: typeof v.height === "number" ? v.height : 0,
    created_at: typeof v.created_at === "string" ? v.created_at : "",
    folder: typeof v.folder === "string" ? v.folder : "",
    scope: mediaScope(public_id),
  };
}

function publicIdOf(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null;
  const v = item as Record<string, unknown>;
  return typeof v.public_id === "string" && v.public_id ? v.public_id : null;
}

function toTotalCount(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return 0;
  const v = raw as Record<string, unknown>;
  const n = v.total_count;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function countDeleted(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return 0;
  const v = raw as Record<string, unknown>;
  if (typeof v.deleted !== "object" || v.deleted === null) return 0;
  return Object.keys(v.deleted).length;
}

function dateMs(value: string): number {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function chunkStrings(list: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// Live asset total across both managed prefixes. Never throws — the counts
// GET must survive an unconfigured or failing image host.
async function getMediaCount(): Promise<{ count: number; error?: string }> {
  if (!process.env.CLOUDINARY_URL) {
    return { count: 0, error: "Image host not configured — media count unavailable." };
  }
  try {
    const api = await cloudinaryAdmin();
    const [app, probe] = await Promise.all([
      api.resources({ type: "upload", prefix: "susej/", max_results: 1 }),
      api.resources({ type: "upload", prefix: "susej-probe/", max_results: 1 }),
    ]);
    return { count: toTotalCount(app) + toTotalCount(probe) };
  } catch (e) {
    return { count: 0, error: e instanceof Error ? e.message : "Media count unavailable — please retry." };
  }
}

// Browse pagination: each page pulls MEDIA_PAGE_SIZE from each managed
// prefix, merges newest-first, and returns at most 2x per page. The opaque
// cursor carries both underlying Admin API cursors.
const MEDIA_PAGE_SIZE = 25;

function encodeMediaCursor(app: string | undefined, probe: string | undefined): string | null {
  if (!app && !probe) return null;
  return Buffer.from(JSON.stringify({ app: app ?? null, probe: probe ?? null }), "utf8").toString("base64url");
}

function decodeMediaCursor(cursor: string): { app?: string; probe?: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const v = parsed as Record<string, unknown>;
    const out: { app?: string; probe?: string } = {};
    if (typeof v.app === "string" && v.app) out.app = v.app;
    if (typeof v.probe === "string" && v.probe) out.probe = v.probe;
    return out;
  } catch {
    return {};
  }
}

async function fetchPrefixPage(
  api: CloudinaryAdminApi,
  prefix: string,
  cursor: string | undefined,
  limit: number
): Promise<{ assets: MediaAsset[]; next: string | undefined }> {
  const raw = await api.resources({
    type: "upload",
    prefix,
    max_results: limit,
    ...(cursor ? { next_cursor: cursor } : {}),
  });
  const page = raw as { resources?: unknown; next_cursor?: unknown };
  const list: unknown[] = Array.isArray(page.resources) ? page.resources : [];
  const assets: MediaAsset[] = [];
  for (const item of list) {
    const asset = toMediaAsset(item);
    if (asset) assets.push(asset);
  }
  const next = typeof page.next_cursor === "string" && page.next_cursor ? page.next_cursor : undefined;
  return { assets, next };
}

async function listMediaPage(cursor: string | null): Promise<{ resources: MediaAsset[]; next_cursor: string | null }> {
  const api = await cloudinaryAdmin();
  const decoded = cursor ? decodeMediaCursor(cursor) : {};
  const [appRes, probeRes] = await Promise.allSettled([
    fetchPrefixPage(api, "susej/", decoded.app, MEDIA_PAGE_SIZE),
    fetchPrefixPage(api, "susej-probe/", decoded.probe, MEDIA_PAGE_SIZE),
  ]);
  const assets: MediaAsset[] = [];
  let appNext: string | undefined;
  let probeNext: string | undefined;
  let failures = 0;
  if (appRes.status === "fulfilled") {
    assets.push(...appRes.value.assets);
    appNext = appRes.value.next;
  } else {
    failures += 1;
  }
  if (probeRes.status === "fulfilled") {
    assets.push(...probeRes.value.assets);
    probeNext = probeRes.value.next;
  } else {
    failures += 1;
  }
  if (failures === 2) throw new Error("Media list unavailable — please retry.");
  assets.sort((a, b) => dateMs(b.created_at) - dateMs(a.created_at));
  return { resources: assets.slice(0, MEDIA_PAGE_SIZE * 2), next_cursor: encodeMediaCursor(appNext, probeNext) };
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

// Selective delete: ONLY the given ids, in 100-chunks. The exact phrase is
// still enforced by the POST handler before this runs.
async function purgeMediaIds(ids: string[]): Promise<ModelResult[]> {
  if (!process.env.CLOUDINARY_URL) {
    return [{ model: "Cloudinary(selected)", skipped: true, error: "CLOUDINARY_URL unset — nothing deleted" }];
  }
  const api = await cloudinaryAdmin();
  const out: ModelResult[] = [];
  for (const part of chunkStrings(ids, 100)) {
    try {
      out.push({
        model: `Cloudinary(selected ${part.length})`,
        deleted: countDeleted(await api.delete_resources(part)),
      });
    } catch (e) {
      out.push({
        model: `Cloudinary(selected ${part.length})`,
        error: e instanceof Error ? e.message : "cloudinary delete failed",
      });
    }
  }
  return out;
}

const MEDIA_LIST_CAP = 5000;

async function listAllPublicIds(
  api: CloudinaryAdminApi,
  prefix: string,
  limit: number
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const raw = await api.resources({
      type: "upload",
      prefix,
      max_results: Math.min(500, Math.max(1, limit - ids.length)),
      ...(cursor ? { next_cursor: cursor } : {}),
    });
    const page = raw as { resources?: unknown; next_cursor?: unknown };
    const list: unknown[] = Array.isArray(page.resources) ? page.resources : [];
    for (const item of list) {
      if (ids.length >= limit) break;
      const id = publicIdOf(item);
      if (id) ids.push(id);
    }
    const next = typeof page.next_cursor === "string" && page.next_cursor ? page.next_cursor : undefined;
    if (ids.length >= limit) return { ids, truncated: next !== undefined };
    if (!next || list.length === 0) return { ids, truncated: false };
    cursor = next;
  }
}

// Bulk wipe that spares keep-prefixed assets (e.g. core images): list every
// id under both prefixes (capped), drop the kept ones, delete the rest in
// 100-chunks. Rows keep the existing per-prefix ModelResult shape.
async function purgeMediaKeeping(keepPrefixes: string[]): Promise<{
  results: ModelResult[];
  kept: number;
  listed: number;
  truncated: boolean;
}> {
  if (!process.env.CLOUDINARY_URL) {
    return {
      results: [
        { model: "Cloudinary(susej/, susej-probe/)", skipped: true, error: "CLOUDINARY_URL unset — nothing deleted" },
      ],
      kept: 0,
      listed: 0,
      truncated: false,
    };
  }
  const api = await cloudinaryAdmin();
  const app = await listAllPublicIds(api, "susej/", MEDIA_LIST_CAP);
  const probe = await listAllPublicIds(api, "susej-probe/", Math.max(0, MEDIA_LIST_CAP - app.ids.length));
  const listed = app.ids.length + probe.ids.length;
  const isKept = (id: string): boolean => keepPrefixes.some((k) => id.startsWith(k));
  const appDoomed = app.ids.filter((id) => !isKept(id));
  const probeDoomed = probe.ids.filter((id) => !isKept(id));
  const kept = listed - appDoomed.length - probeDoomed.length;
  const groups = [
    { prefix: "susej/", doomed: appDoomed },
    { prefix: "susej-probe/", doomed: probeDoomed },
  ];
  const results: ModelResult[] = [];
  for (const group of groups) {
    if (group.doomed.length === 0) {
      results.push({ model: `Cloudinary(${group.prefix})`, deleted: 0 });
      continue;
    }
    let deleted = 0;
    let failure = "";
    for (const part of chunkStrings(group.doomed, 100)) {
      try {
        deleted += countDeleted(await api.delete_resources(part));
      } catch (e) {
        failure = e instanceof Error ? e.message : "cloudinary delete failed";
      }
    }
    results.push(
      failure
        ? { model: `Cloudinary(${group.prefix})`, deleted, error: failure }
        : { model: `Cloudinary(${group.prefix})`, deleted }
    );
  }
  return { results, kept, listed, truncated: app.truncated || probe.truncated };
}

// Lenient option parsing: arrays of text, or a single comma-separated string.
// Anything else is a 400, never a silent ignore.
function asStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  const items: unknown = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(items)) throw new Error(`${field} must be a list of text.`);
  const list: unknown[] = items;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") throw new Error(`${field} must be a list of text.`);
    const t = item.trim();
    if (t) out.push(t);
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
    // Media browse: super_admin/superadmin/owner only, 403 otherwise.
    if (request.nextUrl.searchParams.get("list") === "media") {
      if (!isSuperRole(admin.role)) {
        void writeAudit({
          action: "danger.list",
          entity: "media",
          details: `denied: ${admin.loginId} lacks super_admin`,
          adminName: admin.loginId,
          ip: getClientIp(request),
        });
        return NextResponse.json({ error: "Super Admin only" }, { status: 403 });
      }
      if (!process.env.CLOUDINARY_URL) {
        return NextResponse.json(
          { error: "Image host not configured — media browsing is unavailable." },
          { status: 503 }
        );
      }
      try {
        const page = await listMediaPage(request.nextUrl.searchParams.get("cursor"));
        return NextResponse.json(page);
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : "Media list unavailable — please retry." },
          { status: 503 }
        );
      }
    }
    const prisma = await getPrisma();
    if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    const counts = await allCounts(prisma);
    // media is Cloudinary-only: live Admin API total across both prefixes.
    // A failing image host reports 0 + mediaError — the GET never throws.
    const media = await getMediaCount();
    counts.media = media.count;
    return NextResponse.json(
      media.error
        ? { counts, isSuper: isSuperRole(admin.role), mediaError: media.error }
        : { counts, isSuper: isSuperRole(admin.role) }
    );
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
    let body: { area?: unknown; phrase?: unknown; publicIds?: unknown; keepPrefixes?: unknown };
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
    // Media-only extras for the audit trail (other areas audit unchanged).
    let mediaExtra: {
      selected?: number;
      keepPrefixes?: string[];
      kept?: number;
      listed?: number;
      truncated?: boolean;
    } | null = null;
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
    } else if (area === "media") {
      // Selective delete (publicIds) or keep-spared bulk wipe — the exact
      // phrase was already enforced above for every media path.
      let publicIds: string[];
      let keepPrefixes: string[];
      try {
        publicIds = [...new Set(asStringList(body.publicIds, "publicIds"))];
        keepPrefixes = asStringList(body.keepPrefixes, "keepPrefixes");
      } catch (e) {
        const message = e instanceof Error ? e.message : "Options must be lists of text.";
        void writeAudit({
          action: "danger.purge",
          entity: area,
          details: `validation failed: ${message}`,
          adminName: admin.loginId,
          ip,
        });
        return NextResponse.json({ error: message }, { status: 400 });
      }
      if (publicIds.length > 0) {
        results = await purgeMediaIds(publicIds);
        mediaExtra = { selected: publicIds.length };
      } else if (keepPrefixes.length > 0) {
        const kept = await purgeMediaKeeping(keepPrefixes);
        results = kept.results;
        mediaExtra = {
          keepPrefixes,
          kept: kept.kept,
          listed: kept.listed,
          truncated: kept.truncated,
        };
      } else {
        results = await purgeMedia();
      }
    } else {
      results = await purgeArea(prisma, area);
    }
    const totalDeleted = results.reduce((n, r) => n + (r.deleted ?? 0), 0);
    const failures = results.filter((r) => r.error && !r.skipped).length;
    void writeAudit({
      action: "danger.purge",
      entity: area,
      details: JSON.stringify({ totalDeleted, failures, results, ...(mediaExtra ?? {}) }),
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
