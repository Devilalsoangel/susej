import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { getAppUser } from "@/lib/app-auth";
import { getClientIp } from "@/lib/auth";
import { checkWriteRate } from "@/lib/rate-limit";
import { cachedRead, cacheKey, invalidateCache } from "@/lib/cache";

function epoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma({ probe: false });
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const thread = await prisma.chatThread.findUnique({ where: { id } });
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  const username = auth.user.username!;
  if (thread.participantA !== username && thread.participantB !== username) {
    return NextResponse.json({ error: "Not your thread" }, { status: 403 });
  }

  const beforeRaw = req.nextUrl.searchParams.get("before");
  const beforeMs = beforeRaw ? Number(beforeRaw) : NaN;
  const beforeDate = Number.isFinite(beforeMs) && beforeMs > 0 ? new Date(beforeMs) : null;
  const loadMessages = async () => {
    const latestDesc = await prisma.chatMessage.findMany({
      where: {
        threadId: id,
        ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 101,
    });
    const hasMore = latestDesc.length > 100;
    return { messages: latestDesc.slice(0, 100).reverse(), hasMore };
  };
  const page = await cachedRead(cacheKey("chat", "messages-v2", id, beforeDate ? beforeMs : "latest"), loadMessages, { freshMs: 2_000, staleMs: 60_000, maxBytes: 512_000 });
  const messages = page.messages;
  // Seen-marks scope to exactly what we return: marking the whole thread
  // would fake read-receipts for history the user never saw.
  const seenResult = await prisma.chatMessage.updateMany({
    where: { id: { in: messages.map((m) => m.id) }, receiver: username, status: { not: "seen" } },
    data: { status: "seen" },
  });
  if (seenResult.count > 0) await invalidateCache(cacheKey("chat", "threads-v3", username));
  return NextResponse.json({
    threadId: id,
    hasMore: page.hasMore,
    messages: messages.map((m) => ({
      id: m.id,
      sender: m.sender,
      receiver: m.receiver,
      body: m.body,
      status: m.receiver === username ? "seen" : m.status,
       createdAt: epoch(m.createdAt),
      offer:
        typeof (m as unknown as { offerAmount?: number }).offerAmount === "number"
          ? {
              amount: (m as unknown as { offerAmount: number }).offerAmount,
              productId: String((m as unknown as { offerProductId?: string }).offerProductId ?? ""),
              productName: String((m as unknown as { offerProductName?: string }).offerProductName ?? "Item"),
              status: String((m as unknown as { offerStatus?: string }).offerStatus ?? "pending"),
            }
          : null,
    })),
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!checkWriteRate(`chat-msg:${getClientIp(req)}`, 60)) {
    return NextResponse.json({ error: "Too many requests — slow down" }, { status: 429 });
  }
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const thread = await prisma.chatThread.findUnique({ where: { id } });
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  const username = auth.user.username!;
  // Only thread participants may post into it.
  if (thread.participantA !== username && thread.participantB !== username) {
    return NextResponse.json({ error: "Not your thread" }, { status: 403 });
  }
  const receiver = thread.participantA === username ? thread.participantB : thread.participantA;
  // Server-side block enforcement (either direction, no oracle).
  try {
    const { blockBetween } = await import("@/lib/blocks");
    if (await blockBetween(prisma, username, receiver)) {
      return NextResponse.json({ error: "You can't message this user." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Messaging is temporarily unavailable." }, { status: 503 });
  }

  let body: { body?: string; offer?: { amount?: unknown; productId?: unknown; productName?: unknown } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  // Optional structured price offer (validated; stored in columns + mirrored
  // as human-readable body text so every surface renders something sane).
  let offerData: { offerAmount: number; offerProductId: string; offerProductName: string; offerStatus: string } | null = null;
  if (body.offer !== undefined) {
    const o = body.offer as { amount?: unknown; productId?: unknown; productName?: unknown };
    const amount = Number(o.amount);
    const productId = String(o.productId ?? "").trim();
    const productName = String(o.productName ?? "").trim().slice(0, 200) || "Item";
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
      return NextResponse.json({ error: "Invalid offer amount" }, { status: 400 });
    }
    if (!productId) return NextResponse.json({ error: "Offer needs a listing" }, { status: 400 });
    const listing = await prisma.post.findUnique({
      where: { id: productId },
      select: { authorUsername: true, status: true, isSold: true, stockLeft: true },
    });
    if (
      !listing ||
      String(listing.authorUsername ?? "").toLowerCase() !== receiver.toLowerCase() ||
      listing.status !== "active" ||
      listing.isSold ||
      (listing.stockLeft !== null && listing.stockLeft <= 0)
    ) {
      return NextResponse.json({ error: "This listing is no longer available for offers" }, { status: 409 });
    }
    offerData = { offerAmount: Math.round(amount), offerProductId: productId, offerProductName: productName, offerStatus: "pending" };
  }
  const text = String(body.body ?? "").trim() || (offerData ? `Offer ${offerData.offerAmount} for ${offerData.offerProductName}` : "");
  if (!text) return NextResponse.json({ error: "Message required" }, { status: 400 });
  if (text.length > 2000) return NextResponse.json({ error: "Message too long (max 2000)" }, { status: 400 });

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.chatMessage.create({
      data: { threadId: id, sender: username, receiver, body: text, ...(offerData ?? {}) },
    });
    await tx.chatThread.update({
      where: { id },
      data: { lastMessage: text, lastAt: new Date() },
    });
    return created;
  });
  await invalidateCache(
    cacheKey("chat", "messages-v2", id, "latest"),
    cacheKey("chat", "threads-v3", username),
    cacheKey("chat", "threads-v3", receiver),
  );
  return NextResponse.json(
    {
      message: {
        id: message.id,
        sender: message.sender,
        receiver: message.receiver,
        body: message.body,
        status: message.status,
        createdAt: message.createdAt.getTime(),
        offer: offerData
          ? { amount: offerData.offerAmount, productId: offerData.offerProductId, productName: offerData.offerProductName, status: "pending" }
          : null,
      },
    },
    { status: 201 }
  );
}

/** PATCH — accept / decline / counter a pending offer (either participant). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const thread = await prisma.chatThread.findUnique({ where: { id } });
  if (!thread) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  const username = auth.user.username!;
  if (thread.participantA !== username && thread.participantB !== username) {
    return NextResponse.json({ error: "Not your thread" }, { status: 403 });
  }

  let body: { messageId?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const messageId = String(body.messageId ?? "");
  const next = String(body.status ?? "");
  if (!["accepted", "declined", "countered"].includes(next)) {
    return NextResponse.json({ error: "Invalid offer status" }, { status: 400 });
  }
  const receiver = thread.participantA === username ? thread.participantB : thread.participantA;
  try {
    const { blockBetween } = await import("@/lib/blocks");
    if (await blockBetween(prisma, username, receiver)) {
      return NextResponse.json({ error: "You can't act on this conversation." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Messaging is temporarily unavailable." }, { status: 503 });
  }
  const msg = await prisma.chatMessage.findFirst({ where: { id: messageId, threadId: id } });
  if (!msg || typeof (msg as unknown as { offerAmount?: unknown }).offerAmount !== "number") {
    return NextResponse.json({ error: "Offer not found" }, { status: 404 });
  }
  if ((msg as unknown as { offerStatus?: string }).offerStatus !== "pending") {
    return NextResponse.json({ error: "Offer already decided" }, { status: 409 });
  }
  // No self-dealing: accepting your own offer is meaningless and previously
  // let a seller's tap mint a buyer order on their own device (BUYER-C1).
  // (Decline/counter of your own pending offer stays open as a retract path.)
  if (next === "accepted" && String((msg as unknown as { sender?: unknown }).sender ?? "") === username) {
    return NextResponse.json({ error: "You can't accept your own offer" }, { status: 400 });
  }
  if (next === "accepted") {
    const productId = String((msg as unknown as { offerProductId?: unknown }).offerProductId ?? "");
    const listing = productId
      ? await prisma.post.findUnique({
          where: { id: productId },
          select: { authorUsername: true, status: true, isSold: true, stockLeft: true },
        })
      : null;
    if (
      !listing ||
      String(listing.authorUsername ?? "").toLowerCase() !== receiver.toLowerCase() ||
      listing.status !== "active" ||
      listing.isSold ||
      (listing.stockLeft !== null && listing.stockLeft <= 0)
    ) {
      return NextResponse.json({ error: "This listing is no longer available" }, { status: 409 });
    }
  }
  const changed = await prisma.chatMessage.updateMany({
    where: { id: messageId, threadId: id, offerStatus: "pending" },
    data: { offerStatus: next },
  });
  if (changed.count !== 1) {
    return NextResponse.json({ error: "Offer already decided" }, { status: 409 });
  }
  await invalidateCache(
    cacheKey("chat", "messages-v2", id, "latest"),
    cacheKey("chat", "threads-v3", thread.participantA),
    cacheKey("chat", "threads-v3", thread.participantB),
  );
  return NextResponse.json({ ok: true, status: next });
}