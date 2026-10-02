import { NextRequest, NextResponse } from "next/server";
import { createHash, randomInt } from "crypto";
import type { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db";
import { authPhoneLockKey, authOtpPepperMissing, getAppUser, otpTombstoneValue, parseAppAuthBody, parseAppPhone, parseSendAuthIntent, devOtpExposureAllowed, hashOtpCode, readOtpSendWindow } from "@/lib/app-auth";
import { getClientIp } from "@/lib/auth";

// Per-IP send throttle: the per-phone 45s cooldown alone lets one IP pump
// SMS cost / harass victims / bloat otp rows across distinct numbers.
const SEND_WINDOW_MS = 60_000;
const SEND_MAX = 20;
const sendHits = new Map<string, { count: number; resetAt: number }>();
function throttleSendIp(ip: string): boolean {
  const now = Date.now();
  const cur = sendHits.get(ip);
  if (!cur || now >= cur.resetAt) {
    sendHits.set(ip, { count: 1, resetAt: now + SEND_WINDOW_MS });
    return true;
  }
  cur.count += 1;
  if (cur.count > SEND_MAX) return false;
  return true;
}

// Production OTP request flow:
// - 6-digit random code, stored as a server-peppered HMAC with 5-minute expiry,
//   max 5 verify attempts, single-use (row deleted on success).
// - Delivery through an SMS provider when SMS_API_URL + SMS_API_KEY are set;
//   otherwise AUTH_DEV_MODE (default on in development) returns devCode so
//   the flow stays testable without a provider contract.
const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;
const OTP_TRANSACTION = { maxWait: 10_000, timeout: 15_000 };

function sameStoredChallenge(value: unknown, expected: Prisma.InputJsonValue): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const current = value as Record<string, unknown>;
  const issued = expected as Record<string, unknown>;
  return current.hash === issued.hash && current.issuedAt === issued.issuedAt;
}

async function sendViaSmsProvider(phone: string, code: string): Promise<boolean> {
  const url = process.env.SMS_API_URL;
  const key = process.env.SMS_API_KEY;
  if (!url || !key) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ to: phone, text: `Your susej verification code is ${code}. It expires in 5 minutes.` }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

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
  const intent = parseSendAuthIntent(body.intent, body.create);
  if (!intent) {
    return NextResponse.json({ error: "Auth intent must be login or signup", code: "INVALID_INTENT" }, { status: 400 });
  }
  const phone = parseAppPhone(body.phone);
  if (!phone) {
    return NextResponse.json({ error: "A valid Indian mobile number is required", code: "INVALID_PHONE" }, { status: 400 });
  }
  // Fail closed before minting anything: an unkeyed challenge hash in
  // production is an offline-crackable credential for the phone number.
  if (authOtpPepperMissing()) {
    return NextResponse.json(
      { error: "OTP service is not configured. Please contact support.", code: "AUTH_CONFIG_MISSING" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  if (!throttleSendIp(getClientIp(req))) {
    return NextResponse.json({ error: "Too many codes requested — try again in a minute", code: "RATE_LIMITED" }, { status: 429 });
  }
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable", code: "DATABASE_UNAVAILABLE" }, { status: 503 });

  try {
    const issued = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${authPhoneLockKey(phone)}, 0))`;
      const key = `otp:${phone}`;
      const existing = await tx.appSetting.findUnique({ where: { key } });
      const previous = existing?.value && typeof existing.value === "object" && !Array.isArray(existing.value)
        ? existing.value as Record<string, unknown>
        : {};
      const previousExp = typeof previous.exp === "number" && Number.isFinite(previous.exp) ? previous.exp : null;
      const previousIssuedAt = typeof previous.issuedAt === "number" && Number.isFinite(previous.issuedAt)
        ? previous.issuedAt
        : null;
      // A tombstone (spent/expired/locked) is still a real limiter record: the
      // 45s cooldown and the rolling-hour budget below read it, so burning a
      // code never hands the caller a fresh budget.
      if (previousExp !== null && previousExp > Date.now() && previousIssuedAt !== null &&
          Date.now() - previousIssuedAt < RESEND_COOLDOWN_MS) {
        return { kind: "cooldown" as const };
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const now = Date.now();
      const { sentInWindow, firstSent } = readOtpSendWindow(previous, now);
      if (sentInWindow >= 5) {
        return { kind: "rate-limited" as const };
      }
      const nextValue: Prisma.InputJsonValue = {
        hash: hashOtpCode(phone, code),
        exp: now + OTP_TTL_MS,
        attempts: 0,
        issuedAt: now,
        sent: sentInWindow + 1,
        firstSent,
        intent,
        state: "active",
      };
      await tx.appSetting.upsert({
        where: { key },
        create: { key, value: nextValue },
        update: { value: nextValue },
      });
      return {
        kind: "issued" as const,
        key,
        code,
        value: nextValue,
        hadPrevious: !!existing,
        previousValue: existing?.value as Prisma.InputJsonValue | undefined,
      };
    }, OTP_TRANSACTION);

    if (issued.kind === "cooldown") {
      return NextResponse.json({ error: "Code already sent. Please wait before requesting another.", code: "OTP_COOLDOWN" }, { status: 429 });
    }
    if (issued.kind === "rate-limited") {
      return NextResponse.json({ error: "Too many codes requested — try again in an hour", code: "RATE_LIMITED" }, { status: 429 });
    }

    const delivered = await sendViaSmsProvider(phone, issued.code);
    const devMode = devOtpExposureAllowed(phone);
    if (!delivered && !devMode) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${authPhoneLockKey(phone)}, 0))`;
        const current = await tx.appSetting.findUnique({ where: { key: issued.key } });
        if (!current || !sameStoredChallenge(current.value, issued.value)) return;
        if (issued.hadPrevious) {
          // Put the prior row (live challenge or tombstone) back verbatim.
          await tx.appSetting.update({
            where: { key: issued.key },
            data: { value: issued.previousValue! },
          });
        } else {
          // No prior row: tombstone instead of DELETE. Deleting handed this
          // phone a brand-new limiter (sent 0, firstSent now) for free, so a
          // broken SMS provider became an unlimited retry pump.
          await tx.appSetting.updateMany({
            where: { key: issued.key, value: { equals: issued.value } },
            data: {
              value: otpTombstoneValue(issued.value as Record<string, unknown>, "expired", Date.now()),
            },
          });
        }
      }, OTP_TRANSACTION);
      return NextResponse.json({ error: "SMS delivery is not configured", code: "SMS_UNAVAILABLE" }, { status: 503 });
    }
    return NextResponse.json(
      {
        ok: true,
        intent,
        message: delivered ? "OTP sent" : "OTP generated (dev mode)",
        ...(!delivered && devMode ? { devCode: issued.code } : {}),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ error: "Server hiccup. Please try again.", code: "SERVER_ERROR" }, { status: 500 });
  }
}

/**
 * DELETE /api/app/auth — log out: revoke the caller's session token now
 * (plus ?all=1 to burn every session on the account, e.g. after device
 * theft). Without this a stolen susej_ Bearer stayed valid for the full
 * 30-day TTL with no way to kill it.
 */
export async function DELETE(req: NextRequest) {
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const all = req.nextUrl.searchParams.get("all") === "1";
  if (all) {
    const auth = await getAppUser(req);
    if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    await prisma.appSession.deleteMany({ where: { userId: auth.user.id } });
    return NextResponse.json({ ok: true, revoked: "all" });
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  try {
    await prisma.appSession.deleteMany({ where: { OR: [{ tokenHash }, { token }] } });
  } catch {
    await prisma.appSession.deleteMany({ where: { token } });
  }
  return NextResponse.json({ ok: true, revoked: "current" });
}
