import { NextRequest, NextResponse } from "next/server";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { getPrisma } from "@/lib/db";
import { createAppSession, toAppUser } from "@/lib/app-auth";
import { getClientIp } from "@/lib/auth";

// Email + password auth for app users (buyer/seller).
// Passwords: scrypt (node builtin - no extra dependency), 16-byte random salt,
// stored as `salt:hex` in User.passwordHash. Timing-safe comparison.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Minimal per-IP throttle (single-instance, in-memory): 20 auth attempts per
// minute per IP. Stops credential stuffing; legitimate users never touch it.
// Register has its own stricter bucket (5/hour/IP): each register mints a
// 500 welcome bonus, so uncapped register = farmable money. Email uniqueness
// + ledgered bonus + this cap bound farming to 2500/hr/IP. Full phone-proof
// bonus (credit only after phone verification) needs account linking —
// email and OTP accounts are separate rows today, so this cap is the
// industry-reasonable mitigation until linking lands.
const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_MAX = 20;
const throttleHits = new Map<string, { count: number; resetAt: number }>();
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX = 5;
const registerHits = new Map<string, { count: number; resetAt: number }>();
function throttleIp(req: NextRequest): boolean {
  // Shared getClientIp (x-real-ip else edge-appended XFF tail) — inline
  // first-entry parsing used to defeat this bucket per request.
  const ip = getClientIp(req);
  const now = Date.now();
  const cur = throttleHits.get(ip);
  if (!cur || now >= cur.resetAt) {
    throttleHits.set(ip, { count: 1, resetAt: now + THROTTLE_WINDOW_MS });
    return true;
  }
  cur.count += 1;
  if (cur.count > THROTTLE_MAX) return false;
  return true;
}
function throttleRegister(req: NextRequest): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const cur = registerHits.get(ip);
  if (!cur || now >= cur.resetAt) {
    registerHits.set(ip, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
    return true;
  }
  cur.count += 1;
  if (cur.count > REGISTER_MAX) return false;
  return true;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

// Plus-address farm guard (no migration): test+1@gmail.com and
// test+2@gmail.com are distinct verified rows, each minting 500. Canonicalize
// (strip +tag; strip dots for gmail) and cap same-canonical accounts per week.
function canonicalEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const base = local.split("+")[0];
  // googlemail.com IS gmail.com (same inbox) — one canonical domain.
  const canonDomain = domain === "googlemail.com" ? "gmail.com" : domain;
  const canonLocal = canonDomain === "gmail.com" ? base.replace(/\./g, "") : base;
  return `${canonLocal}@${canonDomain}`;
}
// Returns the count, or -1 when the check itself fails — the register path
// fails CLOSED on -1 (503 try-again): a DB hiccup must never mint money.
async function canonicalFarmCount(prisma: any, canonical: string): Promise<number> {
  const domain = canonical.split("@")[1] ?? "";
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  try {
    // Bounded window with eviction guard: newest-first take can be pushed out
    // by mass same-domain signups, re-opening the farm. Take wider (1000) and
    // fail CLOSED when the same-domain weekly population fills the window —
    // an attacker must then mint 1000 rows AND still gets refused.
    const SCAN_TAKE = 1000;
    const rows = await prisma.user.findMany({
      where: { email: { endsWith: `@${domain}` } },
      select: { email: true, joinedAt: true },
      orderBy: { joinedAt: "desc" },
      take: SCAN_TAKE + 1,
    });
    if (rows.length > SCAN_TAKE) {
      const weekPop = rows.filter(
        (r: { email?: string | null; joinedAt?: Date | null }) =>
          r.joinedAt instanceof Date && r.joinedAt >= weekAgo
      ).length;
      if (weekPop > SCAN_TAKE) return -1;
    }
    return rows.filter(
      (r: { email?: string | null; joinedAt?: Date | null }) =>
        typeof r.email === "string" &&
        canonicalEmail(r.email.trim().toLowerCase()) === canonical &&
        r.joinedAt instanceof Date && r.joinedAt >= weekAgo
    ).length;
  } catch {
    return -1;
  }
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex) return false;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(hex, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export async function POST(req: NextRequest) {
  let body: { action?: string; email?: string; password?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const action = body.action === "register" ? "register" : "login";
  const email = (body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  // CPU-DoS guard (shared 128-char cap): scrypt is synchronous.
  if (password.length < 8 || password.length > 128) return NextResponse.json({ error: "Password must be 8-128 characters" }, { status: 400 });

  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  if (!throttleIp(req)) {
    return NextResponse.json({ error: "Too many attempts — try again in a minute" }, { status: 429 });
  }

  if (action === "register") {
    if (!throttleRegister(req)) {
      return NextResponse.json({ error: "Too many accounts from this network — try again later" }, { status: 429 });
    }
    const name = (body.name ?? "").trim();
    if (name.length < 2) return NextResponse.json({ error: "Enter your full name" }, { status: 400 });
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return NextResponse.json({ error: "An account with this email already exists. Sign in instead." }, { status: 409 });
    // Plus-address farm gate: 2 same-canonical accounts per 7 days max
    // (throttle, not a close — full close needs phone-proof bonus via
    // account linking). Check failure fails closed (503, no mint).
    const farmCount = await canonicalFarmCount(prisma, canonicalEmail(email));
    if (farmCount < 0) {
      return NextResponse.json({ error: "Could not verify — try again" }, { status: 503 });
    }
    if (farmCount >= 2) {
      return NextResponse.json({ error: "Too many accounts from this mailbox — try again later" }, { status: 429 });
    }
    // Username: derived from email local-part, retried until unique (a
    // single retry still 500s on the second collision).
    const base = email.split("@")[0].replace(/[^a-z0-9_]/g, "").slice(0, 20) || "user";
    let user = null;
    for (let attempt = 0; attempt < 5 && !user; attempt += 1) {
      const username = attempt === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`;
      try {
        user = await prisma.user.create({
          data: {
            name,
            email,
            username,
            passwordHash: hashPassword(password),
            walletBalance: 500, // standard welcome grant, same as OTP path
          },
        });
      } catch (e: unknown) {
        if ((e as { code?: string })?.code !== "P2002") throw e;
        // Race-close: a concurrent same-email register won between our
        // findUnique and create. Return the winner's verdict (409 sign-in),
        // not a 503 — the username loop must only retry USERNAME collisions.
        const emailTaken = await prisma.user.findUnique({ where: { email } }).catch(() => null);
        if (emailTaken) {
          return NextResponse.json({ error: "An account with this email already exists. Sign in instead." }, { status: 409 });
        }
      }
    }
    if (!user) return NextResponse.json({ error: "Could not create account — try again" }, { status: 503 });
    await prisma.walletTransaction
      .create({ data: { username: user.username!, title: "Welcome bonus", detail: "Standard welcome grant", amount: 500 } })
      .catch(() => undefined);
    const token = await createAppSession(user.id, user.username!);
    return NextResponse.json({ token, user: toAppUser(user) });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
  }
  // Banned accounts never mint (enforcement was lazy via getAppUser only —
  // the banned user still received a valid 30-day token + full payload).
  if (user.status !== "active") {
    return NextResponse.json({ error: "Account disabled. Contact support." }, { status: 403 });
  }
  const token = await createAppSession(user.id, user.username!);
  return NextResponse.json({ token, user: toAppUser(user) });
}
