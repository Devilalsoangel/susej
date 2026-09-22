import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { getAppUser } from "@/lib/app-auth";

/** Find the caller's own seller application: primary key app_<username>,
 *  falling back to an EXACT phone match for rows filed before the id clamp —
 *  gated on EMAIL match with the caller's token identity. Without it, any
 *  exact phone match (shared family phone, recycled number) returned another
 *  user's businessName/status/docCount to the caller.
 *  No endsWith fallback (cross-user last-10 collisions would leak another
 *  seller's application + KYC state to the caller). */
async function findMine(
  prisma: NonNullable<Awaited<ReturnType<typeof getPrisma>>>,
  username: string,
  phone: string | null,
  email?: string | null
) {
  const byId = await prisma.seller.findUnique({ where: { id: `app_${username}` } }).catch(() => null);
  if (byId) return byId;
  const digits = String(phone ?? "").replace(/\D/g, "");
  const mail = String(email ?? "").trim().toLowerCase();
  if (digits && mail) {
    const byPhone = await prisma.seller.findFirst({
      where: { phone: digits },
      orderBy: { submittedAt: "desc" },
    }).catch(() => null);
    // Ownership proof: the row's email must be the caller's — otherwise this
    // is someone else's application sharing the phone number.
    if (byPhone && String(byPhone.email ?? "").trim().toLowerCase() === mail) return byPhone;
  }
  return null;
}

/**
 * GET /api/app/sellers/me — my own seller application status (server truth).
 * Industry pattern (Amazon/Meesho onboarding): the app fetches this on login
 * and on the become-seller screen so a pending verdict survives reinstalls,
 * relogins and reopens. Missing row -> { application: null } (never 404, so
 * the client treats "never applied / withdrawn" as the wizard state).
 */
export async function GET(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const username = auth.user.username!;
  const row = await findMine(prisma, username, (auth.user as { phone?: unknown }).phone as string | null, (auth.user as { email?: unknown }).email as string | null);
  if (!row) return NextResponse.json({ application: null });

  const [docCount, verifiedDocs, lastAudit] = await Promise.all([
    prisma.sellerDocument.count({ where: { sellerId: row.id } }),
    prisma.sellerDocument.count({ where: { sellerId: row.id, verified: true } }),
    prisma.sellerAuditLog.findFirst({ where: { sellerId: row.id }, orderBy: { timestamp: "desc" } }).catch(() => null),
  ]);

  return NextResponse.json({
    application: {
      id: row.id,
      businessName: row.businessName,
      category: row.category ?? "",
      status: row.kycStatus,
      submittedAt: row.submittedAt instanceof Date ? row.submittedAt.getTime() : new Date(row.submittedAt).getTime(),
      docCount,
      verifiedDocs,
      lastDecision: lastAudit ? { action: lastAudit.action, note: lastAudit.note, at: lastAudit.timestamp.getTime() } : null,
    },
  });
}

/**
 * PATCH /api/app/sellers/me — update my shop profile (tagline/hours/email/
 * phone/address). Owner-only via findMine. tagline/hours are one-shot
 * columns (missing pre-migration → honest localOnly so the app keeps its
 * device copy instead of claiming cross-device truth).
 */
export async function PATCH(req: NextRequest) {
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const username = auth.user.username!;
  const row = await findMine(prisma, username, (auth.user as { phone?: unknown }).phone as string | null, (auth.user as { email?: unknown }).email as string | null);
  if (!row) return NextResponse.json({ error: "No seller application found" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const data: Record<string, unknown> = {};
  if (body.tagline !== undefined) data.tagline = String(body.tagline ?? "").trim().slice(0, 140);
  if (body.hours !== undefined) data.hours = String(body.hours ?? "").trim().slice(0, 140);
  if (body.email !== undefined) {
    const em = String(body.email ?? "").trim().toLowerCase().slice(0, 120);
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
    }
    if (em) data.email = em;
  }
  if (body.phone !== undefined) {
    const digits = String(body.phone ?? "").replace(/\D/g, "").slice(0, 15);
    if (digits && digits.length < 7) return NextResponse.json({ error: "Enter a valid phone number" }, { status: 400 });
    if (digits) data.phone = digits;
  }
  if (body.address !== undefined) data.address = String(body.address ?? "").trim().slice(0, 300);
  if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  try {
    const updated = await prisma.seller.update({ where: { id: row.id }, data });
    return NextResponse.json({ ok: true, shop: { tagline: updated.tagline ?? "", hours: updated.hours ?? "" } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/tagline|hours|column/i.test(msg)) {
      // Pre-migration columns: update the legacy fields that exist, report
      // localOnly for the new ones so the app keeps its device copy honestly.
      const legacy: Record<string, unknown> = {};
      for (const k of ["email", "phone", "address"]) if (data[k] !== undefined) legacy[k] = data[k];
      if (Object.keys(legacy).length) {
        await prisma.seller.update({ where: { id: row.id }, data: legacy }).catch(() => null);
      }
      return NextResponse.json({ ok: true, localOnly: true });
    }
    throw e;
  }
}

/**
 * DELETE /api/app/sellers/me — withdraw my own PENDING application (owner
 * only). Approved sellers cannot self-delete (they hold live store data);
 * rejected applications are removed by re-applying (wizard upserts). The
 * user's own KYC files go with it — their data, their choice.
 */
export async function DELETE(req: NextRequest) {
  void req;
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const username = auth.user.username!;
  const row = await findMine(prisma, username, (auth.user as { phone?: unknown }).phone as string | null, (auth.user as { email?: unknown }).email as string | null);
  if (!row) return NextResponse.json({ ok: true, withdrawn: false });
  if (row.kycStatus !== "pending") {
    return NextResponse.json({ error: "Only a pending application can be withdrawn" }, { status: 409 });
  }
  // Pending applicants cannot own products/orders (creation gates on
  // approved), but refuse rather than strand if that ever changes.
  // Keyed on Post.authorUsername (exact, stable identity) — the old guard
  // matched Product/Order.sellerName by CONTAINS on the mutable businessName:
  // similar names false-refused withdrawals while renamed sellers slipped
  // through. Posts are the live-data signal (products mirror them).
  const [posts, products, orders] = await Promise.all([
    prisma.post.count({ where: { authorUsername: username } }),
    prisma.product.count({ where: { sellerName: row.businessName } }),
    prisma.order.count({ where: { sellerName: row.businessName } }),
  ]);
  if (posts || products || orders) {
    return NextResponse.json({ error: "This application holds live store data — contact support" }, { status: 409 });
  }
  await prisma.seller.delete({ where: { id: row.id } });
  return NextResponse.json({ ok: true, withdrawn: true });
}
