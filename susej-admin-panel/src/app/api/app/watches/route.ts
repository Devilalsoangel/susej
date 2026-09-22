import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { getAppUser } from "@/lib/app-auth";

/**
 * GET /api/app/watches — my price watches.
 * POST /api/app/watches { listingId } — watch (idempotent).
 * DELETE /api/app/watches { listingId } — unwatch.
 * New PriceWatch table (one-shot migration); missing table answers
 * empty/ok so pre-migration clients keep their device-local alerts.
 */
export async function GET(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  try {
    const rows = await prisma.priceWatch.findMany({
      where: { username: auth.user.username! },
      select: { listingId: true, priceAtWatch: true },
    });
    return NextResponse.json({ watches: rows });
  } catch {
    return NextResponse.json({ watches: [] });
  }
}

export async function POST(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  let body: { listingId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const listingId = String(body.listingId ?? "").trim().slice(0, 80);
  if (!listingId) return NextResponse.json({ error: "listingId is required" }, { status: 400 });
  try {
    const post = await prisma.post.findUnique({ where: { id: listingId }, select: { price: true } }).catch(() => null);
    const at = Math.round(Number((post as { price?: unknown } | null)?.price ?? 0));
    await prisma.priceWatch.upsert({
      where: { username_listingId: { username: auth.user.username!, listingId } },
      create: { username: auth.user.username!, listingId, priceAtWatch: at },
      update: { priceAtWatch: at },
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation .* does not exist|does not exist|no such table|Unknown argument|Unknown field/i.test(msg)) {
      return NextResponse.json({ ok: true, localOnly: true });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  let body: { listingId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const listingId = String(body.listingId ?? "").trim();
  if (!listingId) return NextResponse.json({ error: "listingId is required" }, { status: 400 });
  try {
    await prisma.priceWatch.deleteMany({
      where: { username: auth.user.username!, listingId },
    });
  } catch {}
  return NextResponse.json({ ok: true });
}
