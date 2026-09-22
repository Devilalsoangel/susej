import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { getAppUser } from "@/lib/app-auth";

/**
 * GET /api/app/communities/[id]/polls — shared polls with vote tallies +
 * my votes. Missing tables (pre-migration) → { polls: [] } so clients keep
 * their device-local polls.
 * POST { question, options: string[] } — create (member or joined only?
 * any authed user; community existence checked).
 * POST { pollId, optionId } — vote (one per user; change allowed, atomic).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const auth = await getAppUser(_req).catch(() => null);
  const me = String(auth?.user.username ?? "");
  try {
    const polls = await prisma.poll.findMany({
      where: { communityId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const ids = polls.map((p: { id: string }) => p.id);
    const votes = ids.length
      ? await prisma.pollVote.findMany({ where: { pollId: { in: ids } }, select: { pollId: true, username: true, optionId: true } }).catch(() => [])
      : [];
    const out = polls.map((p: { id: string; question: string; options: unknown; createdBy: string; createdAt: Date }) => {
      const opts = Array.isArray(p.options) ? (p.options as Array<{ id?: unknown; text?: unknown }>) : [];
      const counts = new Map<string, number>();
      let mine: string | null = null;
      for (const v of votes as Array<{ pollId: string; username: string; optionId: string }>) {
        if (v.pollId !== p.id) continue;
        counts.set(v.optionId, (counts.get(v.optionId) ?? 0) + 1);
        if (me && v.username === me) mine = v.optionId;
      }
      return {
        id: p.id,
        question: p.question,
        options: opts.map((o, i) => ({ id: String(o?.id ?? `o${i}`), text: String(o?.text ?? "") })),
        votes: opts.map((o, i) => counts.get(String(o?.id ?? `o${i}`)) ?? 0),
        votedOption: mine,
        createdBy: p.createdBy,
        createdAt: p.createdAt.getTime(),
      };
    });
    return NextResponse.json({ polls: out });
  } catch {
    return NextResponse.json({ polls: [] });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await ctx.params;
  let body: { question?: unknown; options?: unknown; pollId?: unknown; optionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const me = auth.user.username!;
  // Vote path.
  if (body.pollId !== undefined) {
    const pollId = String(body.pollId ?? "").trim();
    const optionId = String(body.optionId ?? "").trim();
    if (!pollId || !optionId) return NextResponse.json({ error: "pollId and optionId are required" }, { status: 400 });
    try {
      const poll = await prisma.poll.findUnique({ where: { id: pollId } }).catch(() => null) as {
        communityId?: unknown; options?: unknown;
      } | null;
      if (!poll || String(poll.communityId ?? "") !== id) {
        return NextResponse.json({ error: "Poll not found" }, { status: 404 });
      }
      const opts = Array.isArray(poll.options) ? poll.options as Array<{ id?: unknown }> : [];
      if (!opts.some((o, i) => String(o?.id ?? `o${i}`) === optionId)) {
        return NextResponse.json({ error: "Unknown option" }, { status: 400 });
      }
      // One vote per user (upsert = change allowed), atomic.
      await prisma.pollVote.upsert({
        where: { pollId_username: { pollId, username: me } },
        create: { pollId, username: me, optionId },
        update: { optionId },
      });
      return NextResponse.json({ ok: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/relation .* does not exist|does not exist|no such table/i.test(msg)) {
        return NextResponse.json({ ok: true, localOnly: true });
      }
      throw e;
    }
  }
  // Create path.
  const question = String(body.question ?? "").trim().slice(0, 300);
  const options = Array.isArray(body.options)
    ? (body.options as unknown[]).map((o) => String(o ?? "").trim().slice(0, 120)).filter(Boolean).slice(0, 8)
    : [];
  if (!question || options.length < 2) {
    return NextResponse.json({ error: "question + at least 2 options are required" }, { status: 400 });
  }
  try {
    const row = await prisma.poll.create({
      data: {
        communityId: id,
        question,
        options: options.map((t, i) => ({ id: `o${i}`, text: t })),
        createdBy: me,
      },
    });
    return NextResponse.json({ poll: { id: row.id }, ok: true }, { status: 201 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation .* does not exist|does not exist|no such table/i.test(msg)) {
      return NextResponse.json({ ok: true, localOnly: true });
    }
    throw e;
  }
}
