import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { cacheKey, cachedRead } from "@/lib/cache";
import { getAppUser } from "@/lib/app-auth";
import { checkWriteRate } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/auth";

// Public bundle catalog: active bundle deals with their item contents so the
// app can one-tap add the whole set to cart. Legacy rows without items still
// list (the card links the seller's shop instead).
export async function GET() {
  try {
    const payload = await cachedRead(cacheKey("bundles"), async () => {
      const prisma = await getPrisma({ probe: false });
      if (!prisma) throw new Error("Database unavailable");
      const rows = await prisma.bundle.findMany({
        where: { status: "active" },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      return {
        bundles: rows.map((b) => ({
          id: b.id,
          title: b.title,
          itemsCount: b.itemsCount,
          price: b.price,
          discount: b.discount,
          sellerName: b.sellerName,
          items: Array.isArray(b.items) ? b.items : null,
        })),
      };
    }, { freshMs: 30_000, staleMs: 300_000 });
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
}

/**
 * POST /api/app/bundles — seller composes a combo from OWN live listings.
 * Single-seller enforced (buyer atomicity assumes sane bundles), members
 * must be the seller's published rows, combo price > 0. Server reprices
 * from this row at placement — the client price is preview only.
 */
export async function POST(req: NextRequest) {
  if (!checkWriteRate(`bundles:${getClientIp(req)}`, 20)) {
    return NextResponse.json({ error: "Too many requests — slow down" }, { status: 429 });
  }
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!auth.user.isSeller) {
    return NextResponse.json({ error: "Only sellers can create bundles" }, { status: 403 });
  }
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  // Shared per-account enforcement (one-shot).
  const { checkSharedWriteRate } = await import("@/lib/rate-limit");
  if (!(await checkSharedWriteRate(prisma, `bundles-user:${String(auth.user.username ?? "").toLowerCase()}`, 20))) {
    return NextResponse.json({ error: "Too many requests — slow down" }, { status: 429 });
  }
  let body: { title?: unknown; items?: unknown; price?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const username = auth.user.username!;
  const title = String(body.title ?? "").trim().slice(0, 80);
  const price = Math.floor(Number(body.price ?? NaN));
  const itemIds = Array.isArray(body.items)
    ? [...new Set((body.items as unknown[]).map((i) => String(i ?? "").trim()).filter(Boolean))].slice(0, 10)
    : [];
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  if (!Number.isFinite(price) || price <= 0 || price > 10000000) {
    return NextResponse.json({ error: "price must be between 1 and 10,000,000" }, { status: 400 });
  }
  if (itemIds.length < 2) return NextResponse.json({ error: "Pick at least 2 of your listings" }, { status: 400 });
  // Members must be MY live listings (published, not sold).
  const posts = await prisma.post.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, title: true, description: true, price: true, authorUsername: true, status: true, isSold: true },
  }).catch(() => []);
  if (posts.length !== itemIds.length) {
    return NextResponse.json({ error: "One or more listings were not found — refresh and try again" }, { status: 400 });
  }
  const me = username.toLowerCase();
  for (const p of posts as Array<{ authorUsername?: unknown; status?: unknown; isSold?: unknown; id?: unknown }>) {
    if (String(p.authorUsername ?? "").toLowerCase() !== me) {
      return NextResponse.json({ error: "Bundles hold your listings only" }, { status: 403 });
    }
    if (String(p.status ?? "") !== "published" || p.isSold === true) {
      return NextResponse.json({ error: "Only live listings can join a bundle" }, { status: 400 });
    }
  }
  const contents = (posts as Array<{ id: string; title?: unknown; description?: unknown; price?: unknown }>).map((p) => ({
    listingId: String(p.id),
    name: String(p.title ?? p.description ?? "Item").split("\n")[0].slice(0, 200),
    price: Math.max(0, Math.round(Number(p.price ?? 0))),
  }));
  const mrpSum = contents.reduce((s, c) => s + c.price, 0);
  const row = await prisma.bundle.create({
    data: {
      title,
      itemsCount: contents.length,
      price,
      discount: mrpSum > price ? Math.round(((mrpSum - price) / mrpSum) * 100) : 0,
      sellerName: auth.user.businessName || auth.user.name,
      // Stable owner (one-shot migration; stripped on pre-migration retry).
      sellerUsername: username,
      status: "active",
      createdAt: new Date(),
      items: contents as never,
    },
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/sellerUsername|column/i.test(msg)) {
      return prisma.bundle.create({
        data: {
          title,
          itemsCount: contents.length,
          price,
          discount: mrpSum > price ? Math.round(((mrpSum - price) / mrpSum) * 100) : 0,
          sellerName: auth.user.businessName || auth.user.name,
          status: "active",
          createdAt: new Date(),
          items: contents as never,
        },
      });
    }
    throw e;
  });
  return NextResponse.json({ bundle: { id: row.id, title: row.title }, ok: true }, { status: 201 });
}
