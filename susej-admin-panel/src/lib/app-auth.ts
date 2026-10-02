import { NextRequest } from "next/server";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Prisma, PrismaClient, User } from "@/generated/prisma/client";
import { getPrisma } from "./db";

export const APP_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type AppAuthDb = PrismaClient | Prisma.TransactionClient;

export function appUsernameFromId(id: string): string {
  const suffix = id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  return `user${suffix || "account"}`;
}

export async function ensureAppUsername(db: AppAuthDb, user: User): Promise<User> {
  if (typeof user.username === "string" && user.username.trim().length > 0) return user;
  return db.user.update({
    where: { id: user.id },
    data: { username: appUsernameFromId(user.id) },
  });
}

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
export async function createAppSession(userId: string, username: string, client?: AppAuthDb): Promise<string> {
  const db = client ?? (await getPrisma());
  if (!db) throw new Error("db unavailable");
  const token = `susej_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const last4 = token.slice(-4);
  // Dual-write (one-shot hardening): hash + last4 ride along when the
  // columns exist; pre-migration DBs take the plaintext-only retry. The
  // plaintext column stays until rotation lands (read path prefers hash).
  try {
    await db.appSession.create({
      data: { token, tokenHash, last4, userId, username, expiresAt: new Date(Date.now() + APP_SESSION_TTL_MS) },
    });
  } catch (e: unknown) {
    const message = String((e as { message?: unknown })?.message ?? "");
    if (!/tokenHash|last4|Unknown (argument|field)|column/i.test(message)) throw e;
    await db.appSession.create({
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

export type AppAuthIntent = "login" | "signup";
export type StoredAuthIntent = AppAuthIntent | "legacy";

export function authPhoneLockKey(phone: string): string {
  return `app-auth:${canonPhone(phone)}`;
}

/** Wrong-code attempts allowed per issued challenge. */
export const APP_OTP_MAX_ATTEMPTS = 5;
/** Per-phone codes allowed per rolling hour (send limiter). */
export const APP_OTP_SEND_WINDOW_MS = 60 * 60 * 1000;

/** The dedicated OTP keying secret (AUTH_OTP_PEPPER), or null when unset. */
export function otpPepper(env: NodeJS.ProcessEnv = process.env): string | null {
  return typeof env.AUTH_OTP_PEPPER === "string" && env.AUTH_OTP_PEPPER.length > 0
    ? env.AUTH_OTP_PEPPER
    : null;
}

/**
 * Production refuses to mint or accept a challenge without a keyed secret:
 * the unsalted fallback is only 1e6 offline guesses per leaked row (the phone
 * number is stored right beside the hash), so an unkeyed hash in production is
 * a credential, not a lock. AUTH_OTP_PEPPER is the scoped secret; JWT_SECRET
 * is the existing deployment secret and is accepted as a fallback so a deploy
 * without the new variable still gets keyed HMAC instead of a 503 wall.
 *
 * Local dev/test is never blocked, so on-device OTP testing keeps working.
 */
export function authOtpPepperMissing(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return false;
  return otpSecret(env) === null;
}

function otpSecret(env: NodeJS.ProcessEnv): string | null {
  return otpPepper(env) ?? (typeof env.JWT_SECRET === "string" && env.JWT_SECRET.length > 0 ? env.JWT_SECRET : null);
}

function legacyOtpHash(phone: string, code: string): string {
  return createHash("sha256").update(`${canonPhone(phone)}:${code}`).digest("hex");
}

export function hashOtpCode(phone: string, code: string, env: NodeJS.ProcessEnv = process.env): string {
  const secret = otpSecret(env);
  const message = `${canonPhone(phone)}:${code}`;
  if (!secret) return createHash("sha256").update(message).digest("hex");
  return createHmac("sha256", secret).update(message).digest("hex");
}

function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A peppered pepper means a keyed HMAC; the legacy path is only there so rows
 * written before ANY secret existed still verify in dev. Once a pepper is
 * configured the unsalted fallback is an ORACLE-FREE CRACK PATH: anyone holding
 * a row (DB dump, backup, replica) can enumerate all 1e6 codes in seconds and
 * mint a session for the phone number stored right beside the hash. So a
 * configured pepper also REJECTS every legacy row — in-flight codes minted
 * before the pepper landed (5-minute TTL) simply ask for a resend.
 */
export function verifyOtpCode(
  phone: string,
  code: string,
  storedHash: unknown,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (typeof storedHash !== "string" || !/^[0-9a-f]{64}$/i.test(storedHash)) return false;
  const secret = otpSecret(env);
  if (secret) {
    const candidate = createHmac("sha256", secret).update(`${canonPhone(phone)}:${code}`).digest("hex");
    if (hashesMatch(storedHash, candidate)) return true;
  }
  if (otpPepper(env)) return false;
  return hashesMatch(storedHash, legacyOtpHash(phone, code));
}

/**
 * OTP row lifecycle.
 *
 * The `otp:<phone>` AppSetting row carries BOTH the live challenge (hash, exp,
 * attempts) AND the send-limiter metadata (sent, firstSent). Those used to be
 * the same row and the verify path DELETED the row on expiry, on attempt-lock
 * and on success — which silently reset the limiter (sent -> 0, firstSent ->
 * now) and handed the caller a full 5-codes-this-hour budget again. Five lock
 * cycles = unlimited SMS. Deleting also threw away the 45s cooldown.
 *
 * Fix: the row is never deleted by the verify path. It is rewritten in place
 * (same conditional `value equals` guard = same atomicity) as a TOMBSTONE:
 * no usable hash, but the limiter fields ride along untouched.
 *
 *   spent   — code was used successfully (single-use preserved)
 *   expired — TTL passed
 *   locked  — APP_OTP_MAX_ATTEMPTS wrong codes burned
 *   active  — live challenge (the only state a code can be sent from)
 */
export type OtpRowState = "active" | OtpTombstoneState;
export type OtpTombstoneState = "spent" | "expired" | "locked";

const OTP_TOMBSTONE_STATES: readonly string[] = ["spent", "expired", "locked"];

export function otpRowState(data: Record<string, unknown>): OtpRowState {
  const raw = data.state;
  return typeof raw === "string" && OTP_TOMBSTONE_STATES.includes(raw) ? (raw as OtpTombstoneState) : "active";
}

function otpNumber(data: Record<string, unknown>, key: string, fallback: number): number {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function readOtpAttempts(data: Record<string, unknown>): number {
  return Math.max(0, Math.floor(otpNumber(data, "attempts", 0)));
}

/**
 * Rolling-hour send budget, read straight off whatever the row currently holds
 * (live challenge or tombstone — the limiter fields are identical in both).
 * A stale firstSent starts a fresh window instead of locking the number out.
 */
export function readOtpSendWindow(
  data: Record<string, unknown>,
  now: number
): { sentInWindow: number; firstSent: number } {
  const firstSent = otpNumber(data, "firstSent", now);
  if (now - firstSent >= APP_OTP_SEND_WINDOW_MS) return { sentInWindow: 0, firstSent: now };
  return { sentInWindow: Math.max(0, Math.floor(otpNumber(data, "sent", 0))), firstSent };
}

/**
 * Replacement value for a challenge that must stop verifying. Keeps `hash`
 * empty (nothing to brute-force or replay), keeps `exp`/`issuedAt` so the
 * 45s cooldown still reads honestly, and PRESERVES `sent`/`firstSent` so the
 * per-phone hourly cap survives the burn.
 */
export function otpTombstoneValue(
  data: Record<string, unknown>,
  state: OtpTombstoneState,
  now: number
): Prisma.InputJsonValue {
  const storedExp = otpNumber(data, "exp", now);
  return {
    hash: "",
    // An expired tombstone must not keep a future exp alive, or the send
    // cooldown would report "code already sent" for a code that is gone.
    exp: state === "expired" ? Math.min(storedExp, now) : storedExp,
    attempts: state === "locked" ? APP_OTP_MAX_ATTEMPTS : readOtpAttempts(data),
    issuedAt: otpNumber(data, "issuedAt", now),
    sent: Math.max(0, Math.floor(otpNumber(data, "sent", 0))),
    firstSent: otpNumber(data, "firstSent", now),
    state,
    consumedAt: now,
    ...(typeof data.intent === "string" ? { intent: data.intent } : {}),
  };
}

export function parseAppAuthBody(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseAuthIntent(value: unknown): AppAuthIntent | null {
  return value === "login" || value === "signup" ? value : null;
}

function createFlag(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

export function parseSendAuthIntent(intent: unknown, create?: unknown): StoredAuthIntent | null {
  if (createFlag(create) === null) return null;
  if (intent === undefined) return "legacy";
  return parseAuthIntent(intent);
}

export function parseVerifyAuthIntent(intent: unknown, create?: unknown): AppAuthIntent | null {
  const createValue = createFlag(create);
  if (createValue === null) return null;
  if (intent !== undefined) return parseAuthIntent(intent);
  return createValue === true ? "signup" : "login";
}

export function parseAppPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[^\d]/g, "");
  if (!isIndianPhoneShape(digits)) return null;
  return `91${digits.slice(-10)}`;
}

export function parseOtpCode(value: unknown): string | null {
  return typeof value === "string" && /^\d{6}$/.test(value) ? value : null;
}

export function parseStoredAuthIntent(value: unknown, create?: unknown): StoredAuthIntent | null {
  const createValue = createFlag(create);
  if (createValue === null) return null;
  if (value === "legacy" || value === "*") return "legacy";
  if (value === undefined) return createValue === true ? "signup" : "login";
  return parseAuthIntent(value);
}

export function challengeIntentsMatch(stored: StoredAuthIntent, verify: AppAuthIntent): boolean {
  return stored === "legacy" || stored === verify;
}

export function devOtpExposureAllowed(phone: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return env.AUTH_DEV_MODE !== "0";
  // Production exposure is opt-in AND allowlisted: AUTH_DEV_MODE=1 opens the
  // dev-code path, and only for the numbers in AUTH_DEV_TEST_PHONES. Gating
  // this on VERCEL_ENV === "preview" as well made the production alias
  // unusable - the app points at prod, no SMS provider is configured, so every
  // OTP request fell through to the SMS-unavailable path and nobody could
  // sign in at all. The phone allowlist is the control that keeps the
  // production dev-code path narrow.
  if (env.AUTH_DEV_MODE !== "1") return false;
  const allowed = (env.AUTH_DEV_TEST_PHONES ?? "")
    .split(",")
    .map((value) => canonPhone(value.trim()))
    .filter(Boolean);
  return allowed.includes(canonPhone(phone));
}

export type PhoneVerificationAction = "sign-in" | "needs-signup" | "create" | "account-exists";
export type ChallengeVerificationAction = PhoneVerificationAction | "intent-mismatch";

export function phoneVerificationAction(exists: boolean, wantCreate: boolean): PhoneVerificationAction {
  if (exists) return wantCreate ? "account-exists" : "sign-in";
  return wantCreate ? "create" : "needs-signup";
}

export function resolvePhoneVerificationAction(
  exists: boolean,
  stored: StoredAuthIntent,
  verify: AppAuthIntent
): ChallengeVerificationAction {
  if (!challengeIntentsMatch(stored, verify)) return "intent-mismatch";
  return phoneVerificationAction(exists, verify === "signup");
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
export async function findUserByPhone(phone: string, client?: AppAuthDb) {
  const db = client ?? (await getPrisma());
  if (!db) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  if (!isIndianPhoneShape(digits)) {
    // Exact-digit match only. (No `{ not: null }` guard: combining it with
    // `equals` fails Prisma runtime validation and threw a 500 on every
    // sign-in existence check. NULL rows can never equal a string anyway.)
    return db.user.findFirst({
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
  const exactFirst = await db.user.findFirst({
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
  return null;
}

/**
 * Account creation by verified phone.
 * - Explicit signup lane (create:true): welcomeBonus defaults TRUE (500 + ledger).
 * - Sign-in lane auto-provision (verified code, unknown number): pass
 *   { welcomeBonus: false } — a typo'd number must never mint money. The
 *   account is real and usable; the bonus stays a signup-lane reward.
 */
export async function createUserByPhone(
  phone: string,
  opts?: { welcomeBonus?: boolean; client?: AppAuthDb }
) {
  const welcomeBonus = opts?.welcomeBonus !== false;
  const providedClient = opts?.client;
  const db = providedClient ?? (await getPrisma());
  if (!db) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;
  const national = digits.slice(-10);
  // Foreign-shaped signups keep their own digits (never folded into 91-space,
  // or the @unique on phone collides with the victim's Indian row and the
  // P2002 loser-returns-winner path hands back the VICTIM account).
  const normalized = isIndianPhoneShape(digits) ? `91${national}` : digits;
  const runOn = async (tx: AppAuthDb) => {
    const existing = await findUserByPhone(phone, tx);
    if (existing) return { user: existing, created: false as const };
    const base = `user${national.slice(-4)}`;
    let username = base;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const taken = await tx.user.findUnique({ where: { username } });
      if (!taken) break;
      username = `${base}${Math.floor(Math.random() * 9000 + 1000)}`;
    }
    const user = await tx.user.create({
      data: {
        name: `User ${national.slice(-4)}`,
        email: `user${national.slice(-4)}_${Date.now()}@susej.app`,
        phone: normalized,
        username,
        role: "buyer",
        status: "active",
        walletBalance: welcomeBonus ? 500 : 0,
        joinedAt: new Date(),
      },
    });
    if (welcomeBonus) {
      await tx.walletTransaction.create({
        data: {
          username: user.username ?? `user${digits.slice(-4)}`,
          title: "Welcome bonus",
          amount: 500,
          detail: "Signup credit",
          ts: new Date(),
        },
      });
    }
    return { user, created: true as const };
  };
  try {
    if (providedClient) return await runOn(providedClient);
    return await db.$transaction(async (tx) => runOn(tx));
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== "P2002") throw e;
    if (providedClient) throw e;
    const winner = await findUserByPhone(phone);
    return winner ? { user: winner, created: false as const } : null;
  }
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