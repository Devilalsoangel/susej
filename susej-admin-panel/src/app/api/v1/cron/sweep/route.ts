import { NextRequest, NextResponse } from "next/server";
import { checkAppKeyAsync, unauthorized } from "@/lib/promotions/api-auth";
import { sweepExpiredPromotions, sweepOrphanUploads, sweepSettledAuctions } from "@/lib/promotions/activate";

// CRON_SECRET guards scheduled tasks. If set, the x-cron-secret header must match.
// This separates cron auth from the general app-key — a compromised app-key
// cannot trigger cron sweeps that expire paid promotions.
const CRON_SECRET = process.env.CRON_SECRET ?? "";

async function cronAuth(request: NextRequest): Promise<NextResponse | null> {
  // Prefer dedicated cron secret when configured; fail CLOSED in production
  // when it is missing (never let the widely-distributed app-key expire paid
  // promotions). Local dev keeps the app-key fallback for operability.
  if (CRON_SECRET) {
    const provided = request.headers.get("x-cron-secret");
    if (!provided || provided !== CRON_SECRET) return unauthorized();
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Cron secret not configured" }, { status: 503 });
  } else {
    if (!await checkAppKeyAsync(request)) return unauthorized();
  }
  return null;
}

async function runSweep() {
  const result = await sweepExpiredPromotions();
  if (!result.ok) {
    const status = result.error === "database_unavailable" ? 503 : 500;
    return NextResponse.json({ error: result.error, demo: result.demo ?? false }, { status });
  }
  const orphans = await sweepOrphanUploads();
  const auctions = await sweepSettledAuctions().catch(() => ({ ok: false as const, settled: 0 }));
  // Scheduled-notification runner: due `scheduled` rows flip to `logged`
  // server-side under the same CRON_SECRET, so a blast no longer waits for
  // an admin to open the Notifications page after its due time.
  let notificationsFlipped = 0;
  try {
    const { getPrisma } = await import("@/lib/db");
    const prisma = await getPrisma();
    if (prisma) {
      const due = await (prisma as any).notificationHistoryItem.findMany({
        where: { status: "scheduled" },
        select: { id: true, scheduledFor: true },
        take: 200,
      });
      const now = Date.now();
      const ripe = (Array.isArray(due) ? due : []).filter(
        (h: { scheduledFor?: unknown }) =>
          typeof h.scheduledFor === "string" && h.scheduledFor && !Number.isNaN(Date.parse(h.scheduledFor)) && Date.parse(h.scheduledFor) <= now
      );
      for (const h of ripe) {
        try {
          await (prisma as any).notificationHistoryItem.update({
            where: { id: h.id },
            data: { status: "logged", sentAt: new Date().toISOString() },
          });
          notificationsFlipped += 1;
        } catch {}
      }
    }
  } catch {}
  return NextResponse.json({ ok: true, expired: result.expired, uploadsSwept: orphans, notificationsFlipped, auctionsSettled: (auctions as { settled?: number }).settled ?? 0 });
}

export async function POST(request: NextRequest) {
  const denied = await cronAuth(request);
  if (denied) return denied;
  return runSweep();
}

// Vercel Cron invokes GET (a POST-only route 405s even a correct schedule),
// so the sweep answers both verbs under the same secret. No vercel.json
// schedule ships with the repo — attach the cron in the dashboard.
export async function GET(request: NextRequest) {
  const denied = await cronAuth(request);
  if (denied) return denied;
  return runSweep();
}