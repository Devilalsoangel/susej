import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { cacheKey, cachedRead } from "@/lib/cache";
import { getAppUser } from "@/lib/app-auth";

// Safety window: a stream with no explicit end is auto-ended after 2h so the
// live list reflects reality without a separate cron (lazy expiry pattern).
const MAX_LIVE_MS = 2 * 60 * 60 * 1000;

/** GET /api/app/live — active live-shopping rooms, newest first.
 *  Lazily flips stale streams (older than 2h) to "ended". */
export async function GET(req: NextRequest) {
  void req;
  try {
    const payload = await cachedRead(cacheKey("live"), async () => {
      const prisma = await getPrisma({ probe: false });
      if (!prisma) throw new Error("Database unavailable");
      const cutoff = new Date(Date.now() - MAX_LIVE_MS);
      const [rows, recent] = await Promise.all([
        prisma.liveStream.findMany({
          where: { status: "live", startedAt: { gte: cutoff } },
          orderBy: { startedAt: "desc" },
          take: 50,
        }),
        prisma.liveStream.findMany({ where: { status: "ended" }, orderBy: { endedAt: "desc" }, take: 5 }),
      ]);
      return {
        streams: [...rows, ...recent].map((s) => ({
          id: s.id,
          title: s.title,
          hostName: s.hostName,
          hostUsername: s.hostUsername,
          viewers: s.viewers,
          status: s.status,
          startedAt: s.startedAt.getTime(),
          endedAt: s.endedAt ? s.endedAt.getTime() : null,
        })),
      };
    }, { freshMs: 10_000, staleMs: 30_000 });
    return NextResponse.json(payload);
  } catch {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
}

/** POST /api/app/live — seller goes live. Auth + approved-seller required.
 *  Body: { title }. One live room per host — starting a new one ends the
 *  previous stream for the same host. */
export async function POST(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  // Approved sellers only: isSeller alone includes pending-KYC accounts whose
  // verification was reset (see users/me re-verify). Pending sellers must not
  // be able to broadcast to buyers before review.
  if (!auth.user.isSeller || auth.user.verification !== "approved") {
    return NextResponse.json({ error: "Only approved sellers can go live" }, { status: 403 });
  }
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  // Per-host rate cap: 5 streams/day. One live room per host is already
  // enforced below; this stops start/stop spam flooding the live list.
  try {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = await prisma.liveStream.count({
      where: { hostUsername: auth.user.username!, startedAt: { gte: dayStart } },
    });
    if (today >= 5) {
      return NextResponse.json({ error: "Daily live limit reached (5/day)" }, { status: 429 });
    }
  } catch {}

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  if (!title) return NextResponse.json({ error: "Title required" }, { status: 400 });

  // One live room per host: end any previous open stream first.
  await prisma.liveStream.updateMany({
    where: { hostUsername: auth.user.username!, status: "live" },
    data: { status: "ended", endedAt: new Date() },
  });

  const now = new Date();
  const stream = await prisma.liveStream.create({
    data: {
      title,
      hostName: auth.user.businessName || auth.user.name || auth.user.username!,
      hostUsername: auth.user.username!,
      viewers: 0,
      status: "live",
      startedAt: now,
    },
  });

  return NextResponse.json(
    {
      stream: {
        id: stream.id,
        title: stream.title,
        hostName: stream.hostName,
        hostUsername: stream.hostUsername,
        viewers: stream.viewers,
        status: stream.status,
        startedAt: stream.startedAt.getTime(),
      },
    },
    { status: 201 }
  );
}
