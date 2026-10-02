import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { getAppUser } from "@/lib/app-auth";
import { cachedRead, cacheKey, invalidateCache } from "@/lib/cache";

function epoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma({ probe: false });
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const username = auth.user.username!;
  const loadThreads = async () => {
    let threads = await prisma.chatThread.findMany({
    where: { OR: [{ participantA: username }, { participantB: username }] },
    orderBy: { lastAt: "desc" },
    take: 100,
  });
  // Cross-device block hide (either direction). Missing table = no filter.
  try {
    const { blockedBy, blockedMe } = await import("@/lib/blocks");
    const [byMe, ofMe] = await Promise.all([blockedBy(prisma, username), blockedMe(prisma, username)]);
    if (byMe.size > 0 || ofMe.size > 0) {
      threads = threads.filter((t) => {
        const other = (t.participantA === username ? t.participantB : t.participantA).toLowerCase();
        return !byMe.has(other) && !ofMe.has(other);
      });
    }
  } catch {}

  const unreadRows = await prisma.chatMessage.findMany({
    where: {
      threadId: { in: threads.map((t) => t.id) },
      receiver: username,
      status: { not: "seen" },
    },
    select: { threadId: true },
  });
  const unreadMap = new Map<string, number>();
  unreadRows.forEach((r) => unreadMap.set(r.threadId, (unreadMap.get(r.threadId) ?? 0) + 1));

  // Inbound pending offers per thread (single query): powers the Offers
  // filter + badges honestly on every device — no client-side inference.
  const pendingRows = await prisma.chatMessage.findMany({
    where: {
      threadId: { in: threads.map((t) => t.id) },
      offerStatus: "pending",
      sender: { not: username },
    },
    select: { threadId: true },
  });
  const pendingSet = new Set(pendingRows.map((r) => r.threadId));

  const otherUsernames = [...new Set(threads.map((t) => t.participantA === username ? t.participantB : t.participantA))];
  const profiles = otherUsernames.length
    ? await prisma.user.findMany({
        where: { username: { in: otherUsernames } },
        select: { username: true, name: true, businessName: true, avatar: true },
      })
    : [];
  const profileByUsername = new Map(profiles.filter((u) => u.username).map((u) => [u.username!, u]));
  const out = threads.map((t) => {
    const other = t.participantA === username ? t.participantB : t.participantA;
    const otherUser = profileByUsername.get(other);
    const displayName = otherUser?.businessName?.trim() || otherUser?.name || other;
    return {
      id: t.id,
      otherUsername: other,
      otherName: displayName,
      otherAvatar: otherUser?.avatar ?? undefined,
      lastMessage: t.lastMessage ?? "",
       lastAt: epoch(t.lastAt),
      unread: unreadMap.get(t.id) ?? 0,
      hasPendingOffer: pendingSet.has(t.id),
       pinnedUntil: t.pinnedUntil ? epoch(t.pinnedUntil) : null,
    };
  });
  // A list route must ALWAYS answer with a list. Returning a non-array (or
  // nothing) hands the client `{threads: undefined}`, which it correctly reads
  // as a failure, and used to crash the cache layer instead of degrading here.
  return Array.isArray(out) ? out : [];
  };
   try {
     const out = await cachedRead(cacheKey("chat", "threads-v3", username), loadThreads, { freshMs: 5_000, staleMs: 300_000, maxBytes: 256_000 });
     // A list route must ALWAYS answer with a list. `{threads: undefined}` is
     // what the client correctly reads as "failed to load", so never emit it.
     return NextResponse.json({ threads: Array.isArray(out) ? out : [] });
   } catch {
     return NextResponse.json({ threads: [], degraded: true });
   }
}

export async function POST(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  let body: { participant?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const username = auth.user.username!;
  const other = (body.participant ?? "").trim();
  if (!other || other === username) return NextResponse.json({ error: "Invalid participant" }, { status: 400 });
  const target = await prisma.user.findUnique({ where: { username: other } });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });
  // Server-side block enforcement (either direction): a thread must never
  // open across a block. Same message both ways (no direction oracle).
  try {
    const { blockBetween } = await import("@/lib/blocks");
    if (await blockBetween(prisma, username, other)) {
      return NextResponse.json({ error: "You can't message this user." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Messaging is temporarily unavailable." }, { status: 503 });
  }

  let thread = await prisma.chatThread.findFirst({
    where: {
      OR: [
        { participantA: username, participantB: other },
        { participantA: other, participantB: username },
      ],
    },
  });
  if (!thread) {
    // Industry: canonical ordering eliminates duplicate thread (A,B vs B,A)
    // which the @@unique([participantA, participantB]) alone cannot prevent.
    const [pA, pB] = [username, other].sort((a, b) => a.localeCompare(b));
    try {
      thread = await prisma.chatThread.create({
        data: { participantA: pA, participantB: pB },
      });
    } catch (e: unknown) {
      // Concurrent creation race: another request inserted the thread first.
      // Re-fetch the existing row instead of 500.
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("Unique constraint") || (e as { code?: string })?.code === "P2002") {
        thread = await prisma.chatThread.findFirst({
          where: {
            OR: [
              { participantA: username, participantB: other },
              { participantA: other, participantB: username },
            ],
          },
        });
      }
      if (!thread) throw e;
    }
  }
  await Promise.all([
    invalidateCache(cacheKey("chat", "threads-v3", username)),
    invalidateCache(cacheKey("chat", "threads-v3", other)),
  ]);
  return NextResponse.json({ thread: { id: thread.id, otherUsername: other } }, { status: 201 });
}