import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { getAppUser } from "@/lib/app-auth";
import { checkWriteRate } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/auth";

/**
 * GET /api/app/blocks — usernames I blocked (cross-device truth; the app
 * merges these into its local block list).
 * POST /api/app/blocks { username } — block (idempotent).
 * DELETE /api/app/blocks { username } — unblock.
 * New Block table (one-shot migration); missing table answers empty/ok so
 * pre-migration clients behave exactly as before.
 */
export async function GET(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  try {
    const rows = await prisma.block.findMany({
      where: { blockerUsername: auth.user.username! },
      select: { blockedUsername: true },
    });
    return NextResponse.json({ blocked: rows.map((r: { blockedUsername: string }) => r.blockedUsername) });
  } catch {
    return NextResponse.json({ blocked: [] });
  }
}

export async function POST(req: NextRequest) {
  if (!checkWriteRate(`blocks:${getClientIp(req)}`, 20)) {
    return NextResponse.json({ error: "Too many requests — slow down" }, { status: 429 });
  }
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  let body: { username?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const me = String(auth.user.username ?? "").trim();
  const other = String(body.username ?? "").trim();
  if (!other || other.toLowerCase() === me.toLowerCase()) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }
  const target = await prisma.user.findUnique({ where: { username: other } }).catch(() => null);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });
  try {
    await prisma.block.create({ data: { blockerUsername: me, blockedUsername: other } });
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    const msg = e instanceof Error ? e.message : String(e);
    // Already blocked → idempotent ok. Missing table (pre-migration) →
    // client keeps its device-local list (current behavior).
    if (code === "P2002") return NextResponse.json({ ok: true, deduped: true });
    if (/relation .* does not exist|does not exist|no such table/i.test(msg)) {
      return NextResponse.json({ ok: true, localOnly: true });
    }
    throw e;
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  let body: { username?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const other = String(body.username ?? "").trim();
  if (!other) return NextResponse.json({ error: "username is required" }, { status: 400 });
  try {
    await prisma.block.deleteMany({
      where: { blockerUsername: auth.user.username!, blockedUsername: other },
    });
  } catch {
    // Missing table → nothing server-side to remove; client list stands.
  }
  return NextResponse.json({ ok: true });
}
