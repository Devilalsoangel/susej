import { NextRequest, NextResponse } from "next/server";
import type { Prisma, User } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db";
import { authPhoneLockKey, authOtpPepperMissing, createAppSession, createUserByPhone, ensureAppUsername, findUserByPhone, toAppUser, parseAppAuthBody, parseAppPhone, parseVerifyAuthIntent, parseOtpCode, parseStoredAuthIntent, challengeIntentsMatch, resolvePhoneVerificationAction, verifyOtpCode, otpRowState, otpTombstoneValue, readOtpAttempts, APP_OTP_MAX_ATTEMPTS } from "@/lib/app-auth";
import { getClientIp } from "@/lib/auth";

// Consumes the hashed OTP stored by POST /api/app/auth:
// expiry check, attempt cap (5), single-use. The row is NEVER deleted — the
// send limiter (sent/firstSent) lives in that same row, and deleting it on
// expiry / lock / success reset the budget to zero and made the hourly cap
// bypassable forever. Each burn rewrites the row as a tombstone under the same
// conditional value guard, so the code stops verifying but the limiter stays.
const MAX_ATTEMPTS = APP_OTP_MAX_ATTEMPTS;
const OTP_TRANSACTION = { maxWait: 10_000, timeout: 15_000 };

// Minimal per-IP throttle (single-instance, in-memory): 30 verifies per
// minute per IP. The per-phone 45s resend cooldown stops code spam, but
// without this a botnet could brute-force codes across many phones.
const VERIFY_WINDOW_MS = 60_000;
const VERIFY_MAX = 30;
const verifyHits = new Map<string, { count: number; resetAt: number }>();
// Creation bucket (mirrors email register: 5/hour/IP). Each OTP creation
// mints a 500 welcome bonus, so uncapped create = farmable money. Sign-in
// (existing user) is never throttled by this — only minting is.
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const CREATE_MAX = 5;
const createHits = new Map<string, { count: number; resetAt: number }>();
function throttleCreateIp(req: NextRequest): boolean {
  // getClientIp (shared): x-real-ip first, else edge-appended last XFF entry.
  // Inline first-entry parsing used to hand a fresh bucket to every spoofed
  // header — all IP throttles in this file were bypassable per request.
  const ip = getClientIp(req);
  const now = Date.now();
  const cur = createHits.get(ip);
  if (!cur || now >= cur.resetAt) {
    createHits.set(ip, { count: 1, resetAt: now + CREATE_WINDOW_MS });
    return true;
  }
  cur.count += 1;
  if (cur.count > CREATE_MAX) return false;
  return true;
}
function throttleVerifyIp(req: NextRequest): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const cur = verifyHits.get(ip);
  if (!cur || now >= cur.resetAt) {
    verifyHits.set(ip, { count: 1, resetAt: now + VERIFY_WINDOW_MS });
    return true;
  }
  cur.count += 1;
  if (cur.count > VERIFY_MAX) return false;
  return true;
}

type VerifyResult =
  | { kind: "not-requested" }
  | { kind: "expired" }
  | { kind: "intent-mismatch" }
  | { kind: "locked" }
  | { kind: "incorrect"; attemptsLeft: number }
  | { kind: "changed" }
  | { kind: "account-exists" }
  | { kind: "account-disabled" }
  | { kind: "signup-required" }
  | {
      kind: "session";
      token: string;
      user: User;
      mode: "login" | "signup";
      created: boolean;
      setupRequired: boolean;
    };

class CreateRateLimitedError extends Error {}

export async function POST(req: NextRequest) {
  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body", code: "INVALID_BODY" }, { status: 400 });
  }
  const body = parseAppAuthBody(parsedBody);
  if (!body || Object.keys(body).length === 0) {
    return NextResponse.json({ error: "Invalid body", code: "INVALID_BODY" }, { status: 400 });
  }
  const intent = parseVerifyAuthIntent(body.intent, body.create);
  if (!intent) {
    return NextResponse.json({ error: "Auth intent must be login or signup", code: "INVALID_INTENT" }, { status: 400 });
  }
  const phone = parseAppPhone(body.phone);
  if (!phone) {
    return NextResponse.json({ error: "A valid Indian mobile number is required", code: "INVALID_PHONE" }, { status: 400 });
  }
  if (!throttleVerifyIp(req)) {
    return NextResponse.json({ error: "Too many attempts — try again in a minute", code: "RATE_LIMITED" }, { status: 429 });
  }
  const code = parseOtpCode(body.code);
  if (!code) {
    return NextResponse.json({ error: "Enter the 6-digit code", code: "INVALID_CODE" }, { status: 400 });
  }
  // Production verifies with AUTH_OTP_PEPPER only. JWT_SECRET / unsalted
  // fallbacks stay in dev so local OTP testing keeps working; without this gate
  // a deployed serverless instance could fall back to the crackable legacy
  // path even though the environment is hardened.
  if (authOtpPepperMissing()) {
    return NextResponse.json(
      { error: "OTP service is not configured. Please contact support.", code: "AUTH_CONFIG_MISSING" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable", code: "DATABASE_UNAVAILABLE" }, { status: 503 });

  try {
    const result = await prisma.$transaction(async (tx): Promise<VerifyResult> => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${authPhoneLockKey(phone)}, 0))`;
      const otpKey = `otp:${phone}`;
      const rec = await tx.appSetting.findUnique({ where: { key: otpKey } });
      const data = rec?.value && typeof rec.value === "object" && !Array.isArray(rec.value)
        ? rec.value as Record<string, unknown>
        : null;
      if (!rec || !data) {
        return { kind: "not-requested" };
      }
      // Tombstones are terminal and idempotent: repeat verifies get the same
      // answer the burn produced, with no further write. Reading them BEFORE the
      // hash check is what keeps an empty-hash tombstone from being reported
      // as a fresh "no code requested".
      const state = otpRowState(data);
      if (state === "expired") return { kind: "expired" };
      if (state === "locked") return { kind: "locked" };
      if (state === "spent") return { kind: "not-requested" };
      if (typeof data.hash !== "string" || data.hash.length === 0) {
        return { kind: "not-requested" };
      }
      const guard = { key: otpKey, value: { equals: rec.value as Prisma.InputJsonValue } };
      const burn = async (tombstone: "expired" | "locked" | "spent") => {
        const updated = await tx.appSetting.updateMany({
          where: guard,
          data: { value: otpTombstoneValue(data, tombstone, Date.now()) },
        });
        return updated.count === 1;
      };
      if (typeof data.exp !== "number" || !Number.isFinite(data.exp) || data.exp < Date.now()) {
        return (await burn("expired")) ? { kind: "expired" as const } : { kind: "changed" as const };
      }
      const storedIntent = parseStoredAuthIntent(data.intent, data.create);
      if (!storedIntent || !challengeIntentsMatch(storedIntent, intent)) {
        return { kind: "intent-mismatch" };
      }
      const attempts = readOtpAttempts(data);
      if (attempts >= MAX_ATTEMPTS) {
        return (await burn("locked")) ? { kind: "locked" as const } : { kind: "changed" as const };
      }
      const codeHash = data.hash;
      if (!verifyOtpCode(phone, code, codeHash)) {
        const updated = await tx.appSetting.updateMany({
          where: guard,
          data: {
            value: {
              hash: codeHash,
              exp: data.exp as number,
              attempts: attempts + 1,
              issuedAt: typeof data.issuedAt === "number" ? data.issuedAt : 0,
              sent: typeof data.sent === "number" ? data.sent : 0,
              firstSent: typeof data.firstSent === "number" ? data.firstSent : 0,
              intent: storedIntent,
              state: "active",
            },
          },
        });
        if (updated.count !== 1) return { kind: "changed" };
        return { kind: "incorrect", attemptsLeft: MAX_ATTEMPTS - attempts - 1 };
      }

      // Single-use: the code is spent BEFORE the account branch runs, so a
      // replay of the same code can never re-enter signup / session creation.
      if (!(await burn("spent"))) return { kind: "changed" };

      const existing = await findUserByPhone(phone, tx);
      const accountAction = resolvePhoneVerificationAction(Boolean(existing), storedIntent, intent);
      if (accountAction === "account-exists") return { kind: "account-exists" };
      if (accountAction === "needs-signup") return { kind: "signup-required" };
      if (accountAction === "sign-in") {
        if (!existing || existing.status !== "active") return { kind: "account-disabled" };
        const user = await ensureAppUsername(tx, existing);
        const token = await createAppSession(user.id, user.username!, tx);
        return {
          kind: "session",
          token,
          user,
          mode: "login",
          created: false,
          setupRequired: false,
        };
      }
      if (accountAction !== "create") return { kind: "intent-mismatch" };
      if (!throttleCreateIp(req)) throw new CreateRateLimitedError();
      const creation = await createUserByPhone(phone, { welcomeBonus: true, client: tx });
      if (!creation) throw new Error("account creation failed");
      if (!creation.created) return { kind: "account-exists" };
      if (creation.user.status !== "active") return { kind: "account-disabled" };
      const user = await ensureAppUsername(tx, creation.user);
      const token = await createAppSession(
        user.id,
        user.username!,
        tx
      );
      return {
        kind: "session",
        token,
        user: creation.user,
        mode: "signup",
        created: true,
        setupRequired: true,
      };
    }, OTP_TRANSACTION);

    if (result.kind === "not-requested") {
      return NextResponse.json(
        { error: "No code requested. Tap Resend.", code: "OTP_NOT_REQUESTED" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (result.kind === "expired") {
      return NextResponse.json(
        { error: "Code expired. Request a new one.", code: "OTP_EXPIRED" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (result.kind === "intent-mismatch") {
      return NextResponse.json(
        { error: "The verification intent does not match. Request a new code.", code: "INTENT_MISMATCH" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (result.kind === "locked") {
      return NextResponse.json(
        { error: "Too many attempts. Request a new code.", code: "OTP_LOCKED" },
        { status: 429, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (result.kind === "incorrect") {
      return NextResponse.json(
        { error: "Incorrect code", code: "OTP_INCORRECT", attemptsLeft: result.attemptsLeft },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (result.kind === "changed") {
      return NextResponse.json(
        { error: "Verification state changed. Request a new code.", code: "OTP_CHANGED" },
        { status: 409, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (result.kind === "account-exists") {
      return NextResponse.json(
        { error: "An account with this number already exists. Sign in instead.", code: "ACCOUNT_EXISTS", accountExists: true },
        { status: 409, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (result.kind === "account-disabled") {
      return NextResponse.json(
        { error: "Account disabled. Contact support.", code: "ACCOUNT_DISABLED" },
        { status: 403, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (result.kind === "signup-required") {
      return NextResponse.json(
        { error: "No account found for this number. Create one to continue.", code: "SIGNUP_REQUIRED", needsSignup: true },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      {
        token: result.token,
        user: toAppUser(result.user),
        mode: result.mode,
        created: result.created,
        setupRequired: result.setupRequired,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e: unknown) {
    if (e instanceof CreateRateLimitedError) {
      return NextResponse.json({ error: "Too many accounts from this network — try again later", code: "RATE_LIMITED" }, { status: 429 });
    }
    return NextResponse.json({ error: "Server hiccup. Please try again.", code: "SERVER_ERROR" }, { status: 500 });
  }
}
