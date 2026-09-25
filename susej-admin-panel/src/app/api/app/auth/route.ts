import { NextRequest, NextResponse } from "next/server";
import { createHash, randomInt } from "crypto";
import { getPrisma } from "@/lib/db";
import { getAppUser, isIndianPhoneShape, canonPhone, devOtpExposureAllowed } from "@/lib/app-auth";
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
// - 6-digit random code, stored as SHA-256 hash with 5-minute expiry,
//   max 5 verify attempts, single-use (row deleted on success).
// - Delivery through an SMS provider when SMS_API_URL + SMS_API_KEY are set;
//   otherwise AUTH_DEV_MODE (default on in development) returns devCode so
//   the flow stays testable without a provider contract.
const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;
const MAX_ATTEMPTS = 5;

function hashCode(phone: string, code: string): string {
  return createHash("sha256").update(`${phone}:${code}`).digest("hex");
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
  let body: { phone?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const raw = (body.phone ?? "").replace(/\D/g, "");
  if (!raw || raw.length < 10) {
    return NextResponse.json({ error: "A valid 10-digit phone number is required" }, { status: 400 });
  }
  // India-only product (INR identity, 91-normalized accounts): codes are
  // issued to Indian shapes only. A foreign number sharing an Indian
  // account's last 10 digits must never receive a code — the verify step
  // binds sessions by phone, and cross-country issuance is account takeover.
  if (!isIndianPhoneShape(raw)) {
    return NextResponse.json({ error: "Only Indian (+91) mobile numbers are supported" }, { status: 400 });
  }
  // Canonical identity: format variants (0-trunk, 91-prefix) share one OTP
  // row, one cooldown, one hourly counter — never parallel live codes.
  const phone = canonPhone(raw);
  if (!throttleSendIp(getClientIp(req))) {
    return NextResponse.json({ error: "Too many codes requested — try again in a minute" }, { status: 429 });
  }
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  // Every DB touch below can throw (Neon timeout, pool drop on serverless):
  // without this guard the throw becomes a 500 HTML page, and the app shows
  // a raw red "HTTP 500". Always answer JSON.
  try {
  // Cooldown: an unexpired request cannot be re-issued inside the window.
  const existing = await prisma.appSetting.findUnique({ where: { key: `otp:${phone}` } });
  if (existing?.value) {
    const prev = existing.value as { exp?: number; issuedAt?: number };
    if (typeof prev.exp === "number" && prev.exp > Date.now() &&
        typeof prev.issuedAt === "number" && Date.now() - prev.issuedAt < RESEND_COOLDOWN_MS) {
      return NextResponse.json({ error: "Code already sent. Please wait before requesting another." }, { status: 429 });
    }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = Date.now();
  // Hourly send cap per phone (brute-force bound): each code allows 5 verify
  // attempts, and resends reset the counter — uncapped resends mean unbounded
  // guesses. Cap 5 codes/hour/phone (Json row, no migration); the 6th send
  // inside the window 429s. Legit users never hit 5/hour.
  const prevVal = (existing?.value ?? null) as { sent?: number; firstSent?: number } | null;
  const windowStart = typeof prevVal?.firstSent === "number" ? prevVal.firstSent : now;
  const sentInWindow = now - windowStart < 3600 * 1000 ? Number(prevVal?.sent ?? 0) : 0;
  if (sentInWindow >= 5) {
    return NextResponse.json({ error: "Too many codes requested — try again in an hour" }, { status: 429 });
  }
  await prisma.appSetting.upsert({
    where: { key: `otp:${phone}` },
    create: { key: `otp:${phone}`, value: { hash: hashCode(phone, code), exp: now + OTP_TTL_MS, attempts: 0, issuedAt: now, sent: 1, firstSent: now } },
    update: { value: { hash: hashCode(phone, code), exp: now + OTP_TTL_MS, attempts: 0, issuedAt: now, sent: sentInWindow + 1, firstSent: sentInWindow > 0 ? windowStart : now } },
  });

  const delivered = await sendViaSmsProvider(phone, code);
  const devMode = devOtpExposureAllowed(phone);
  if (!delivered && !devMode) {
    return NextResponse.json({ error: "SMS delivery is not configured" }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    message: delivered ? "OTP sent" : "OTP generated (dev mode)",
    ...(!delivered && devMode ? { devCode: code } : {}),
  });
  } catch {
    return NextResponse.json({ error: "Server hiccup. Please try again." }, { status: 500 });
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
  const auth = await getAppUser(req);
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const all = req.nextUrl.searchParams.get("all") === "1";
  if (all) {
    await prisma.appSession.deleteMany({ where: { userId: auth.user.id } });
  } else {
    await prisma.appSession.delete({ where: { id: auth.session.id } });
  }
  return NextResponse.json({ ok: true, revoked: all ? "all" : "current" });
}
