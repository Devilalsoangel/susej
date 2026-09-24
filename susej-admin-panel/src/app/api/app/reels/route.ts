import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { cacheKey, cachedRead } from "@/lib/cache";
import { getAppUser } from "@/lib/app-auth";
import { validateMediaRefs } from "@/lib/media";

/**
 * Seller reels, server-distributed (Instagram pattern). Reels were previously
 * device-local only: a seller "published" and no buyer or admin ever saw it.
 * POST requires a seller account; GET serves published reels, optionally
 * filtered by seller username for storefronts and the reels rail.
 */
export async function GET(req: NextRequest) {
  const seller = req.nextUrl.searchParams.get("seller")?.trim() || undefined;
  const take = Math.min(Number(req.nextUrl.searchParams.get("take") ?? 50) || 50, 50);
  try {
    const payload = await cachedRead(cacheKey("reels", seller ?? "all", take), async () => {
      const prisma = await getPrisma({ probe: false });
      if (!prisma) throw new Error("Database unavailable");
      const rows = await prisma.reel.findMany({
        where: {
          status: "published",
          ...(seller ? { creatorUsername: seller } : {}),
        },
        orderBy: { createdAt: "desc" },
        take,
      });
      return {
        reels: rows.map((r) => ({
          id: r.id,
          title: r.title,
          caption: r.caption ?? "",
          mediaUrl: r.mediaUrl ?? "",
          creatorName: r.creatorName,
          creatorUsername: r.creatorUsername ?? "",
          views: r.views,
          likes: r.likes,
          createdAt: r.createdAt.getTime(),
        })),
      };
    }, { freshMs: 30_000, staleMs: 600_000 });
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!auth.user.isSeller) {
    return NextResponse.json({ error: "Only sellers can publish reels" }, { status: 403 });
  }
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const caption = String(body.caption ?? "").trim().slice(0, 300);
  const rawMedia = Array.isArray(body.mediaUrl)
    ? (body.mediaUrl as unknown[])
    : typeof body.mediaUrl === "string"
      ? [body.mediaUrl]
      : typeof body.image === "string"
        ? [body.image]
        : [];
  // Cover must already be hosted (client uploads first) — local file:// URIs
  // are unviewable on any other device and are rejected, same as listings.
  const mediaCheck = validateMediaRefs(rawMedia as string[], { min: 1, max: 1, field: "reel cover" });
  if (!mediaCheck.ok) {
    return NextResponse.json({ error: mediaCheck.error }, { status: 400 });
  }
  const row = await prisma.reel.create({
    data: {
      title: caption.slice(0, 80) || "New reel",
      caption,
      mediaUrl: mediaCheck.urls[0],
      creatorName: auth.user.businessName || auth.user.name,
      creatorUsername: auth.user.username!,
      views: 0,
      likes: 0,
      status: "published",
      createdAt: new Date(),
    },
  });
  return NextResponse.json(
    {
      reel: {
        id: row.id,
        title: row.title,
        caption: row.caption ?? "",
        mediaUrl: row.mediaUrl ?? "",
        creatorName: row.creatorName,
        creatorUsername: row.creatorUsername ?? "",
      },
    },
    { status: 201 }
  );
}

// PATCH /api/app/reels { id, action: "view" } — counts a watch. Authed only,
// per-IP throttled (same viewer hammering still inflates: full fraud
// filtering needs a view-events table — roadmap, not silent precision).
// Likes stay unwired (no toggle table exists; showing a live 0 that can never
// move is worse than the endpoint — like counts render only when > 0).
const VIEW_WINDOW_MS = 60_000;
const VIEW_MAX = 60;
const viewHits = new Map<string, { count: number; resetAt: number }>();

export async function PATCH(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { getClientIp } = await import("@/lib/auth");
  const ip = getClientIp(req);
  const now = Date.now();
  const cur = viewHits.get(ip);
  if (!cur || now >= cur.resetAt) {
    viewHits.set(ip, { count: 1, resetAt: now + VIEW_WINDOW_MS });
  } else {
    cur.count += 1;
    if (cur.count > VIEW_MAX) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (body.action !== "view" && body.action !== "like" || typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: 'Expected { id, action: "view" | "like" }.' }, { status: 400 });
  }
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  if (body.action === "like") {
    // Explicit-state like (idempotent): the client sends the DESIRED value,
    // so a stale local toggle never inverts server truth. Toggle when omitted.
    // Missing table (pre-migration) → client keeps its local animation.
    try {
      const me = auth.user.username!;
      const want = typeof (body as { value?: unknown }).value === "boolean" ? (body as { value: boolean }).value : null;
      const liked = await prisma.$transaction(async (tx: any) => {
        const existing = await tx.reelLike.findUnique({
          where: { reelId_username: { reelId: String(body.id), username: me } },
        }).catch(() => null);
        const shouldLike = want ?? !existing;
        if (shouldLike && !existing) {
          await tx.reelLike.create({ data: { reelId: String(body.id), username: me } });
          await tx.reel.updateMany({ where: { id: String(body.id), status: "published" }, data: { likes: { increment: 1 } } });
          return true;
        }
        if (!shouldLike && existing) {
          await tx.reelLike.delete({ where: { id: existing.id } });
          const cur = await tx.reel.findUnique({ where: { id: String(body.id) }, select: { likes: true } }).catch(() => null);
          if (Number((cur as { likes?: unknown } | null)?.likes ?? 0) > 0) {
            await tx.reel.updateMany({ where: { id: String(body.id) }, data: { likes: { decrement: 1 } } });
          }
          return false;
        }
        return !!existing;
      });
      const row = await prisma.reel.findUnique({ where: { id: String(body.id) }, select: { likes: true } }).catch(() => null);
      return NextResponse.json({ ok: true, liked, likes: Math.max(0, Number((row as { likes?: unknown } | null)?.likes ?? 0)) });
    } catch {
      return NextResponse.json({ error: "Likes are not available yet" }, { status: 503 });
    }
  }
  const updated = await prisma.reel.updateMany({
    where: { id: String(body.id), status: "published" },
    data: { views: { increment: 1 } },
  });
  if (!updated.count) return NextResponse.json({ error: "Reel not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
