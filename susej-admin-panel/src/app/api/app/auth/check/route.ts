import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import { findUserByPhone, parseAppAuthBody, parseAppPhone } from "@/lib/app-auth";
import { getClientIp } from "@/lib/auth";

// Existence probe for the sign-in screen: "does this number have an account?"
// Lets login redirect unknown numbers to the signup flow BEFORE any OTP is
// sent or any account is minted. Returns only a boolean — never user data —
// and shares the verify-style per-IP throttle so numbers can't be farmed.
// (Same disclosure level as verify's 404 needsSignup; enumeration is
//  rate-bounded, matching the existing check-username precedent.)
const CHECK_WINDOW_MS = 60_000;
const CHECK_MAX = 30;
const checkHits = new Map<string, { count: number; resetAt: number }>();

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
  const startedAt = Date.now();
  const ip = getClientIp(req);
  const now = Date.now();
  const cur = checkHits.get(ip);
  if (!cur || now >= cur.resetAt) {
    checkHits.set(ip, { count: 1, resetAt: now + CHECK_WINDOW_MS });
  } else {
    cur.count += 1;
    if (cur.count > CHECK_MAX) {
      return NextResponse.json({ error: "Too many attempts — try again in a minute", code: "RATE_LIMITED" }, { status: 429 });
    }
  }
  const phone = parseAppPhone(body.phone);
  if (!phone) {
    return NextResponse.json({ error: "A valid Indian mobile number is required", code: "INVALID_PHONE" }, { status: 400 });
  }
  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable", code: "DATABASE_UNAVAILABLE" }, { status: 503 });
  try {
    const user = await findUserByPhone(phone);
    const elapsed = Date.now() - startedAt;
    if (elapsed < 300) await new Promise((r) => setTimeout(r, 300 - elapsed));
    return NextResponse.json({ exists: !!user });
  } catch {
    return NextResponse.json({ error: "Server hiccup. Please try again.", code: "SERVER_ERROR" }, { status: 500 });
  }
}
