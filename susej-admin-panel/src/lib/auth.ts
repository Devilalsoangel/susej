import { randomBytes, scryptSync, timingSafeEqual, createHmac, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import type { NextRequest } from "next/server";

// Signing key MUST come from env. A hardcoded fallback would let anyone who
// reads the repo forge admin sessions. In production runtime without env we
// FAIL LOUD (throw at boot) so a wiped env pages instead of silently bouncing
// logins across instances (Sep-14 ephemeral-JWT outage). Build phase stays
// silent (no runtime to warn to); local dev keeps the loud console warning.
const SECRET =
  process.env.JWT_SECRET ??
  (() => {
    const isBuild = process.env.NEXT_PHASE?.includes("build");
    if (isBuild) {
      // During build there is no runtime to warn to; keep silent.
      return randomBytes(48).toString("hex");
    }
    if (process.env.NODE_ENV === "production" && typeof window === "undefined") {
      throw new Error(
        "[auth] JWT_SECRET is not set in production — refusing to boot with an ephemeral secret. Set JWT_SECRET (stable 64-hex) and redeploy."
      );
    }
    console.warn(
      "[auth] JWT_SECRET not set - using an EPHEMERAL per-boot secret. All sessions invalidate on restart. Set JWT_SECRET in .env."
    );
    return randomBytes(48).toString("hex");
  })();

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

interface SessionPayload {
  typ: "admin-session";
  aud: "susej-admin";
  sub: string;
  name: string;
  role: string;
  loginId: string;
  exp: number;
  /** Issued-at (revocation horizon) + password verifier (revocation key). */
  iat?: number;
  ph?: string;
}

/** Password verifier: any password change invalidates all sessions minted
 *  before it (migration-free revocation — no schema change needed). */
export function sessionPasswordVerifier(passwordHash: string): string {
  return sha256Hex(`susej-sess-v1:${passwordHash}`).slice(0, 16);
}

function hmac(payload: string, domain: "session" | "challenge"): Buffer {
  const h = createHmac("sha256", SECRET);
  h.update(`${domain}.`);
  h.update(payload);
  return h.digest();
}

export function signSession(admin: { id: string; name: string; role: string; loginId: string }, passwordHash?: string): string {
  const payload: SessionPayload = {
    typ: "admin-session",
    aud: "susej-admin",
    sub: admin.id,
    name: admin.name,
    role: admin.role,
    loginId: admin.loginId,
    // 24h (was 7d): stolen-cookie replay, logout gap, and stale-privilege
    // windows all shrink to a day. Writes re-check the Admin row per request
    // (getActiveAdmin) so ban/demote bites immediately, not at next login.
    exp: Date.now() + 24 * 60 * 60 * 1000,
    iat: Date.now(),
    ...(passwordHash ? { ph: sessionPasswordVerifier(passwordHash) } : {}),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmac(body, "session").toString("base64url");
  return `${body}.${sig}`;
}

export function verifySessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = hmac(body, "session");
  const provided = Buffer.from(sig, "base64url");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (
      payload.typ !== "admin-session" ||
      payload.aud !== "susej-admin" ||
      typeof payload.sub !== "string" || !payload.sub ||
      typeof payload.name !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.loginId !== "string" ||
      typeof payload.exp !== "number" || payload.exp <= Date.now() ||
      typeof payload.iat !== "number"
    ) return null;
    if (payload.ph !== undefined && typeof payload.ph !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

import { SESSION_COOKIE, CHALLENGE_COOKIE } from "./session-cookie";
export { SESSION_COOKIE, CHALLENGE_COOKIE };
export const SESSION_MAX_AGE = 24 * 60 * 60;
export const MAX_PASSWORD_LEN = 128;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_LOGIN_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

interface ChallengePayload {
  typ: "admin-2fa";
  aud: "susej-admin-2fa";
  sub: string;
  jti: string;
  exp: number;
}

export function signChallenge(admin: { id: string }): string {
  const payload: ChallengePayload = {
    typ: "admin-2fa",
    aud: "susej-admin-2fa",
    sub: admin.id,
    jti: randomBytes(24).toString("base64url"),
    exp: Date.now() + CHALLENGE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmac(body, "challenge").toString("base64url");
  return `${body}.${sig}`;
}

export function verifyChallengeToken(token: string | undefined): ChallengePayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = hmac(body, "challenge");
  const provided = Buffer.from(sig, "base64url");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ChallengePayload;
    if (
      payload.typ !== "admin-2fa" ||
      payload.aud !== "susej-admin-2fa" ||
      typeof payload.sub !== "string" || !payload.sub ||
      typeof payload.jti !== "string" || !payload.jti ||
      typeof payload.exp !== "number" || payload.exp <= Date.now()
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const TOTP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function encodeBase32(value: Buffer): string {
  let bits = "";
  for (const byte of value) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let index = 0; index < bits.length; index += 5) {
    output += TOTP_ALPHABET[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  }
  return output;
}

function decodeBase32(value: string): Buffer | null {
  const clean = value.replace(/[\s-]/g, "").replace(/=+$/g, "").toUpperCase();
  if (!clean || [...clean].some((char) => !TOTP_ALPHABET.includes(char))) return null;
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 5) | TOTP_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function deriveTotpSecret(seed: string, account: string): string {
  return encodeBase32(createHmac("sha256", seed).update(`susej-admin:${account}`).digest().subarray(0, 20));
}

export function totpCode(secret: string, at = Date.now()): string | null {
  const key = decodeBase32(secret);
  if (!key) return null;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

export function verifyTotpCode(secret: string, code: string, at = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const candidate = Buffer.from(code);
  for (const offset of [-1, 0, 1]) {
    const expected = totpCode(secret, at + offset * 30_000);
    if (expected && candidate.length === expected.length && timingSafeEqual(candidate, Buffer.from(expected))) return true;
  }
  return false;
}

function twoFactorKey(): Buffer {
  const configured = process.env.TWO_FACTOR_ENCRYPTION_KEY;
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("TWO_FACTOR_ENCRYPTION_KEY is required in production");
  }
  return Buffer.from(sha256Hex(`susej-admin-2fa:${configured ?? SECRET}`), "hex");
}

export function protectTotpSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", twoFactorKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function revealTotpSecret(stored: string | null | undefined): string | null {
  if (!stored?.startsWith("v1.")) return null;
  try {
    const [, ivRaw, encryptedRaw, tagRaw] = stored.split(".");
    if (!ivRaw || !encryptedRaw || !tagRaw) return null;
    const decipher = createDecipheriv("aes-256-gcm", twoFactorKey(), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export function totpAuthUri(secret: string, account: string): string {
  const label = encodeURIComponent(`SUSEJ:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("SUSEJ")}&algorithm=SHA1&digits=6&period=30`;
}

/* ------------------------------------------------------------------ *
 * PENDING AUTHENTICATOR ENROLLMENT (enroll-2fa / rotate-2fa)
 *
 * A replacement secret must never take effect before the owner proves
 * the NEW factor works (scanned it, produced a live code). So the
 * candidate secret is never written to Admin.twoFactorCode up front: it
 * is sealed into an AES-GCM HttpOnly cookie and the current factor keeps
 * authenticating until a confirm call promotes the candidate.
 *   - no schema change (migration-free by design; Admin is untouched)
 *   - fail-closed: the seal reuses protectTotpSecret, so a production
 *     boot without TWO_FACTOR_ENCRYPTION_KEY throws instead of falling
 *     back to a weaker key
 *   - bound to (adminId, mode) + self-expiring: a blob minted for one
 *     admin (or for enroll) can neither be replayed by another admin
 *     nor used to swap modes
 * ------------------------------------------------------------------ */
export const PENDING_ENROLL_COOKIE = "susej_pending_2fa";
export const PENDING_ENROLL_TTL_MS = 10 * 60 * 1000;
export type PendingTotpMode = "enroll" | "rotate";

interface PendingTotpPayload {
  /** Admin id the candidate belongs to. */
  a: string;
  /** Flow that minted it — an enroll blob is not a valid rotate blob. */
  m: PendingTotpMode;
  /** Candidate base32 secret. */
  s: string;
  /** Expiry (epoch ms). */
  exp: number;
}

export function sealPendingTotp(adminId: string, mode: PendingTotpMode, secret: string): string {
  const payload: PendingTotpPayload = { a: adminId, m: mode, s: secret, exp: Date.now() + PENDING_ENROLL_TTL_MS };
  return protectTotpSecret(JSON.stringify(payload));
}

/** Returns the candidate secret, or null for missing/tampered/expired/
 *  wrong-admin/wrong-mode blobs. A tampered cookie fails GCM auth. */
export function openPendingTotp(value: string | undefined, adminId: string, mode: PendingTotpMode): string | null {
  if (!value) return null;
  const raw = revealTotpSecret(value);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as Partial<PendingTotpPayload>;
    if (payload?.a !== adminId || payload?.m !== mode) return null;
    if (typeof payload.s !== "string" || !payload.s) return null;
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    return payload.s;
  } catch {
    return null;
  }
}

export function pendingTotpCookieOptions() {
  return {
    path: "/",
    maxAge: PENDING_ENROLL_TTL_MS / 1000,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

export function clearedPendingTotpCookieOptions() {
  return { path: "/", maxAge: 0 };
}

/* --- factor attempt budget (shared by enroll-2fa + rotate-2fa) ------- *
 * A 6-digit TOTP code is only 10^6 guesses wide, so EVERY proof-of-factor
 * step is budgeted per admin+phase. Deliberately separate from the
 * password failedAttempts/lockedUntil column: exhausting a factor budget
 * must not lock the admin out of the panel (lockout-DoS), it only forces
 * a fresh, correctly-proven flow. In-memory per isolate, same standing
 * residual as the login/2FA throttles.
 * -------------------------------------------------------------------- */
const FACTOR_WINDOW_MS = 10 * 60 * 1000;
const factorFails = new Map<string, { count: number; resetAt: number }>();

export function factorFailureCount(key: string): number {
  const cur = factorFails.get(key);
  if (!cur) return 0;
  if (Date.now() >= cur.resetAt) {
    factorFails.delete(key);
    return 0;
  }
  return cur.count;
}

export function factorLockedOut(key: string): boolean {
  return factorFailureCount(key) >= MAX_LOGIN_ATTEMPTS;
}

export function noteFactorFailure(key: string): number {
  const now = Date.now();
  // Bounded map: prune expired windows instead of growing per admin id.
  if (factorFails.size > 500) {
    for (const [staleKey, value] of factorFails) {
      if (now >= value.resetAt) factorFails.delete(staleKey);
    }
  }
  const cur = factorFails.get(key);
  if (!cur || now >= cur.resetAt) {
    factorFails.set(key, { count: 1, resetAt: now + FACTOR_WINDOW_MS });
    return 1;
  }
  cur.count += 1;
  return cur.count;
}

export function clearFactorFailures(key: string): void {
  factorFails.delete(key);
}

/* Per-IP ceiling for factor-management endpoints. Rides alongside the
 * per-admin budget so a spray from one source is capped even before the
 * per-admin counters fill. */
const TOTP_MGMT_WINDOW_MS = 60_000;
const TOTP_MGMT_MAX = 20;
const totpMgmtHits = new Map<string, { count: number; resetAt: number }>();

export function throttleTotpManagement(ip: string): boolean {
  const now = Date.now();
  if (totpMgmtHits.size > 500) {
    for (const [staleKey, value] of totpMgmtHits) {
      if (now >= value.resetAt) totpMgmtHits.delete(staleKey);
    }
  }
  const cur = totpMgmtHits.get(ip);
  if (!cur || now >= cur.resetAt) {
    totpMgmtHits.set(ip, { count: 1, resetAt: now + TOTP_MGMT_WINDOW_MS });
    return true;
  }
  cur.count += 1;
  return cur.count <= TOTP_MGMT_MAX;
}

export function generateResetToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: sha256Hex(raw) };
}

export function getClientIp(request: NextRequest): string {
  // Trust order matters: clients can inject arbitrary X-Forwarded-For entries
  // and Vercel appends the real client IP AFTER them — so the FIRST entry is
  // attacker-controlled while x-real-ip (set by the edge) is authoritative.
  // Old code took the first XFF entry: rotating the header per request gave a
  // fresh throttle bucket every time (all IP throttles + audit IPs defeated).
  // Residual hardening: x-real-ip is edge-set ONLY behind Vercel (x-vercel-id
  // present). Off-edge origins (direct/preview hits) could spoof it per
  // request to rotate throttle buckets + forge audit IPs — there we fall back
  // to the LAST XFF entry (closest proxy, hardest to spoof without an
  // allowlist) instead of the edge header.
  if (request.headers.get("x-vercel-id")) {
    const real = request.headers.get("x-real-ip")?.trim();
    if (real) return real;
  }
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return "unknown";
}

/**
 * Fresh admin identity for request handling: verifies the signature, then
 * re-reads the Admin row (status + role are LIVE, never frozen at login).
 * Returns null for bad/expired tokens, missing rows, and non-active accounts —
 * so ban/deactivate/demote take effect on the NEXT request, not next login.
 * Fail-closed (null) when the DB is unreachable: a panel that cannot read its
 * own admin table must not serve stale-privilege sessions.
 */
export async function getActiveAdmin(
  request: NextRequest
): Promise<{ id: string; name: string; role: string; loginId: string; sessionIssuedAt: number } | null> {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  try {
    const { getPrisma } = await import("./db");
    const prisma = await getPrisma();
    if (!prisma) return null;
    const admin = await prisma.admin.findUnique({ where: { id: session.sub } });
    if (!admin || (admin as { status?: unknown }).status !== "active") return null;
    // Revocation: sessions minted with a password verifier die on the next
    // password reset/change (hash rotates). Pre-fix tokens carry no verifier
    // and stay valid until their 24h expiry — accepted deliberately so the
    // rollout never logs out the whole team at once.
    if (session.ph) {
      const cur = sessionPasswordVerifier(String((admin as { passwordHash?: unknown }).passwordHash ?? ""));
      if (session.ph !== cur) return null;
    }
    return {
      id: (admin as { id: string }).id,
      name: String((admin as { name?: unknown }).name ?? ""),
      role: String((admin as { role?: unknown }).role ?? ""),
      loginId: String((admin as { loginId?: unknown }).loginId ?? ""),
      // When this session was minted (SessionPayload.iat, always a number —
      // verifySessionToken rejects anything else). Security changes that must
      // not run on a long-lived, possibly-stolen cookie (2FA rotation) gate
      // on the AGE of the session and ask for a fresh sign-in. Coerced with a
      // 0 fallback so a missing iat reads as "infinitely old" = refused,
      // never as "brand new" = allowed.
      sessionIssuedAt: Number(session.iat ?? 0),
    };
  } catch {
    return null;
  }
}