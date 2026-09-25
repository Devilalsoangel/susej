import { NextRequest } from "next/server";
import type { User } from "@/generated/prisma/client";
import { getPrisma } from "./db";

export const APP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function getAppToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

/** Resolve the app user from the Bearer token. Returns null when unauthenticated. */
export async function getAppUser(req: NextRequest) {
  const token = getAppToken(req);
  if (!token) return null;
  const prisma = await getPrisma();
  if (!prisma) {
    const error = new Error('Database unavailable') as Error & { code?: string };
    error.code = 'DB_UNAVAILABLE';
    throw error;
  }
  // Hash-first (one-shot hardening): new sessions store sha256(tokenHash);
  // the plaintext `token` column stays readable until rotation lands, then
  // goes away. Pre-migration DBs reject the unknown field → fall through.
  let session: {
    id: string;
    expiresAt: Date;
    user: User;
  } | null = null;
  try {
    const { createHash } = await import("crypto");
    const digest = createHash("sha256").update(token).digest("hex");
    session = await prisma.appSession.findUnique({
      where: { tokenHash: digest },
      include: { user: true },
    }).catch(() => null);
  } catch {
    session = null;
  }
  if (!session) {
    session = await prisma.appSession.findUnique({
      where: { token },
      include: { user: true },
    });
  }
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.appSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (session.user.status !== "active") return null;
  return { session, user: session.user };
}

/** Issue a new app session token for a user id. */
export async function createAppSession(userId: string, username: string): Promise<string> {
  const prisma = await getPrisma();
  if (!prisma) throw new Error("db unavailable");
  const { randomBytes, createHash } = await import("crypto");
  const token = `susej_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const last4 = token.slice(-4);
  // Dual-write (one-shot hardening): hash + last4 ride along when the
  // columns exist; pre-migration DBs take the plaintext-only retry. The
  // plaintext column stays until rotation lands (read path prefers hash).
  try {
    await prisma.appSession.create({
      data: { token, tokenHash, last4, userId, username, expiresAt: new Date(Date.now() + APP_SESSION_TTL_MS) },
    });
  } catch {
    await prisma.appSession.create({
      data: { token, userId, username, expiresAt: new Date(Date.now() + APP_SESSION_TTL_MS) },
    });
  }
  return token;
}

/**
 * Indian-number shape test (the product is India-only: INR, 91-normalized
 * identity). 10-digit nationals, 12-digit 91-prefixed, 11-digit 0-trunk.
 * Anything else is foreign-shaped and MUST NOT be folded into 91-space.
 */
export function isIndianPhoneShape(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  return (
    digits.length === 10 ||
    (digits.length === 12 && digits.startsWith("91")) ||
    (digits.length === 11 && digits.startsWith("0"))
  );
}

/**
 * Canonical phone identity (P0 fix): every OTP/cooldown/counter key and every
 * lookup uses this form, so 9876543210 / 919876543210 / 09876543210 collapse
 * to ONE identity — one live code, one cooldown, one hourly counter. Without
 * this, format variants minted independent OTP rows (SMS pump multiplier).
 */
export function canonPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (isIndianPhoneShape(digits)) return `91${digits.slice(-10)}`;
  return digits;
}

/**
 * Pure phone lookup (used by OTP verify). NEVER creates — creation is an
 * explicit signup decision (see createUserByPhone). Silent auto-provision on
 * a typo'd number used to mint ghost accounts + 500 welcome money each.
 *
 * Country lock: foreign-shaped input matches EXACT digits only. Normalizing a
 * foreign number into 91-space (or endsWith-matching its last 10) would bind
 * the verified session to a DIFFERENT person's Indian account — cross-country
 * account takeover with nothing but a same-last-10 number.
 */
export async function findUserByPhone(phone: string) {
  const prisma = await getPrisma();
  if (!prisma) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  if (!isIndianPhoneShape(digits)) {
    // Exact-digit match only. (No `{ not: null }` guard: combining it with
    // `equals` fails Prisma runtime validation and threw a 500 on every
    // sign-in existence check. NULL rows can never equal a string anyway.)
    return prisma.user.findFirst({
      where: { OR: [{ phone: digits }, { phone }] },
    });
  }
  // Normalize to E.164-ish India form (91 + last 10) so a paste of
  // "911556848908" (+91 + 12-digit national) does not create a 14-digit
  // duplicate (91911556848908) distinct from the intended 12-digit row.
  // FIX Sep 15: tony 911556848908 was showing as user8908 because the
  // double-country bug spawned a ghost account.
  const national = digits.slice(-10);
  const normalized = `91${national}`;
  // Deterministic priority: exact normalized first, then exact raw forms,
  // and only then the endsWith fallback. A single findFirst with OR is
  // ambiguous when a ghost duplicate exists (tony 911556848908 vs ghost
  // 91911556848908 both end with 1556848908) — the DB could return either.
  // Exact forms first (same note: no `{ not: null }` combined with
  // `equals`/`endsWith` — Prisma runtime rejects it with a 500).
  const exactFirst = await prisma.user.findFirst({
    where: {
      OR: [
        { phone: normalized },
        { phone: digits },
        { phone },
        { phone: national },
      ],
    },
  });
  if (exactFirst) return exactFirst;
  const candidate = await prisma.user.findFirst({
    where: { phone: { endsWith: national } as never },
  });
  if (candidate) return candidate;
  return null;
}

/**
 * Account creation by verified phone.
 * - Explicit signup lane (create:true): welcomeBonus defaults TRUE (500 + ledger).
 * - Sign-in lane auto-provision (verified code, unknown number): pass
 *   { welcomeBonus: false } — a typo'd number must never mint money. The
 *   account is real and usable; the bonus stays a signup-lane reward.
 */
export async function createUserByPhone(phone: string, opts?: { welcomeBonus?: boolean }) {
  const welcomeBonus = opts?.welcomeBonus !== false;
  const prisma = await getPrisma();
  if (!prisma) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  const national = digits.slice(-10);
  // Foreign-shaped signups keep their own digits (never folded into 91-space,
  // or the @unique on phone collides with the victim's Indian row and the
  // P2002 loser-returns-winner path hands back the VICTIM account).
  const normalized = isIndianPhoneShape(digits) ? `91${national}` : digits;
  // Re-check under creation: a concurrent signup may have landed first.
  const existing = await findUserByPhone(phone);
  if (existing) return existing;
  // New phone → fresh buyer account. Username must be unique even when two
  // phones share the same last 4 digits (user0001-style collisions hard-500'd).
  const base = `user${national.slice(-4)}`;
  let username = base;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const taken = await prisma.user.findUnique({ where: { username } });
    if (!taken) break;
    username = `${base}${Math.floor(Math.random() * 9000 + 1000)}`;
  }
  // Race-close (API-H3): phone is @unique, so a concurrent signup for the
  // same number throws P2002 here even after the re-check above. Loser
  // returns the winner — one account, one bonus, never a dup + double mint.
  let created;
  try {
    created = await prisma.user.create({
      data: {
        name: `User ${national.slice(-4)}`,
        email: `user${national.slice(-4)}_${Date.now()}@susej.app`,
        phone: normalized,
        username,
        role: "buyer",
        status: "active",
        walletBalance: welcomeBonus ? 500 : 0, // sign-in lane: no minting
        joinedAt: new Date(),
      },
    });
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "P2002") return findUserByPhone(phone);
    throw e;
  }
  if (!created) return null;
  // Ledger the bonus so every rupee in the wallet is traceable - an
  // unaudited balance is indistinguishable from minted money. Skipped
  // entirely on the bonus-free lane (nothing to trace).
  if (welcomeBonus) {
  try {
    await prisma.walletTransaction.create({
      data: {
        username: created.username ?? `user${digits.slice(-4)}`,
        title: "Welcome bonus",
        amount: 500,
        detail: "Signup credit",
        ts: new Date(),
      },
    });
  } catch {
    // Ledger write must never block login; balance stays authoritative.
  }
  }
  return created;
}

/** Public user shape (mirrors the app's User type). */
export function toAppUser(u: {
  name: string;
  username: string | null;
  phone: string | null;
  email: string;
  avatar: string | null;
  bio: string | null;
  location: string | null;
  interests: unknown;
  role: string;
  isSeller: boolean;
  businessName: string | null;
  category: string | null;
  verification: string;
  walletBalance: number;
  loyaltyPoints: number;
  joinedAt: Date;
}) {
  return {
    name: u.name,
    username: u.username ?? "",
    phone: u.phone ?? "",
    email: u.email,
    avatar: u.avatar ?? undefined,
    bio: u.bio ?? "",
    location: u.location ?? "",
    interests: Array.isArray(u.interests) ? u.interests : [],
    role: u.role === "both" ? "both" : u.isSeller ? "both" : "buyer",
    isSeller: u.isSeller,
    businessName: u.businessName ?? "",
    category: u.category ?? "",
    verification: u.verification as "none" | "pending" | "approved" | "rejected",
    walletBalance: u.walletBalance,
    loyaltyPoints: u.loyaltyPoints,
    joinedAt: u.joinedAt.toISOString(),
  };
}