import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import {
  MAX_LOGIN_ATTEMPTS,
  MAX_PASSWORD_LEN,
  PENDING_ENROLL_COOKIE,
  PENDING_ENROLL_TTL_MS,
  clearedPendingTotpCookieOptions,
  clearFactorFailures,
  factorLockedOut,
  generateTotpSecret,
  getActiveAdmin,
  getClientIp,
  noteFactorFailure,
  openPendingTotp,
  pendingTotpCookieOptions,
  protectTotpSecret,
  sealPendingTotp,
  throttleTotpManagement,
  totpAuthUri,
  verifyPassword,
  verifyTotpCode,
} from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

/** Rotating the second factor is a security change: it runs on the live session
 *  plus the password, so an old (possibly replayed) 24h cookie must not be
 *  enough. Above this age the admin is asked to sign in again — a fresh sign-in
 *  means the current factor was proven too, which is the intent. */
const ROTATE_SESSION_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * POST /api/login/rotate-2fa
 *   begin  { password }        -> PENDING candidate secret (writes NOTHING)
 *   confirm { confirm: true, code } -> promotes the pending candidate
 *
 * Pre-fix, one call overwrote Admin.twoFactorCode immediately. The old factor
 * died the moment the request landed — before the new secret was added to any
 * app, and even if the response never reached the browser (network drop, closed
 * tab, "I saved it" clicked without scanning). The admin was then locked out of
 * their own panel and the only recovery was a DB edit. Now the live factor keeps
 * working until the candidate proves itself with a live code.
 */
export async function POST(request: NextRequest) {
  const auth = await getActiveAdmin(request).catch(() => null);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let password = "";
  let code = "";
  let confirm = false;
  try {
    const body = (await request.json()) as { password?: unknown; code?: unknown; confirm?: unknown } | null;
    password = String(body?.password ?? "");
    code = String(body?.code ?? "").trim();
    confirm = body?.confirm === true;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const ip = getClientIp(request);
  if (!throttleTotpManagement(ip)) {
    return NextResponse.json({ error: "Too many attempts — wait a minute and try again." }, { status: 429 });
  }

  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable." }, { status: 503 });
  const admin = await prisma.admin.findUnique({ where: { id: auth.id } });
  if (!admin || admin.status !== "active") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /* ---------------- confirm: promote the pending candidate ---------------- */
  if (confirm) {
    const budgetKey = `rotate-confirm:${auth.id}`;
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "Enter the 6-digit code from your NEW authenticator." }, { status: 400 });
    }
    if (factorLockedOut(budgetKey)) {
      return NextResponse.json(
        { error: "Too many wrong codes. Rotate again in a few minutes." },
        { status: 429 }
      );
    }
    const pendingSecret = openPendingTotp(request.cookies.get(PENDING_ENROLL_COOKIE)?.value, auth.id, "rotate");
    if (!pendingSecret) {
      return NextResponse.json(
        { error: "No rotation in progress. Rotate again to get a new setup key." },
        { status: 401 }
      );
    }
    if (!verifyTotpCode(pendingSecret, code)) {
      const fails = noteFactorFailure(budgetKey);
      const exhausted = fails >= MAX_LOGIN_ATTEMPTS;
      await writeAudit({
        action: "auth.2fa.rotate_confirm_failed",
        entity: "admins",
        entityId: auth.id,
        details: exhausted ? "2FA confirm budget exhausted — pending rotation dropped" : "Wrong code confirming rotated authenticator",
        adminName: auth.loginId,
        ip,
      });
      const response = NextResponse.json(
        {
          error: exhausted
            ? "Too many wrong codes. Rotate again."
            : "That code does not match the new setup key. Your current authenticator still works.",
        },
        { status: 401 }
      );
      if (exhausted) response.cookies.set(PENDING_ENROLL_COOKIE, "", clearedPendingTotpCookieOptions());
      return response;
    }
    clearFactorFailures(budgetKey);
    await prisma.admin.update({
      where: { id: auth.id },
      data: { twoFactorCode: protectTotpSecret(pendingSecret), twoFactorEnabled: true },
    });
    await writeAudit({
      action: "auth.2fa.rotated",
      entity: "admins",
      entityId: auth.id,
      details: "Authenticator enrollment rotated (confirmed with a live code)",
      adminName: auth.loginId,
      ip,
    });
    const response = NextResponse.json({ rotated: true, confirmed: true, twoFactorEnabled: true });
    response.cookies.set(PENDING_ENROLL_COOKIE, "", clearedPendingTotpCookieOptions());
    return response;
  }

  /* ---------------------------- begin: candidate -------------------------- */
  const sessionAge = Date.now() - auth.sessionIssuedAt;
  if (sessionAge > ROTATE_SESSION_MAX_AGE_MS) {
    await writeAudit({
      action: "auth.2fa.rotate_denied",
      entity: "admins",
      entityId: auth.id,
      details: "Rotation refused on a stale session — fresh sign-in required",
      adminName: auth.loginId,
      ip,
    });
    return NextResponse.json(
      { error: "Your session is older than 1 hour. Sign in again, then rotate your authenticator." },
      { status: 401 }
    );
  }

  if (!password || password.length > MAX_PASSWORD_LEN) {
    return NextResponse.json({ error: "Current password is required." }, { status: 400 });
  }
  const passwordKey = `rotate-password:${auth.id}`;
  if (factorLockedOut(passwordKey)) {
    return NextResponse.json(
      { error: "Too many failed attempts. Try again in a few minutes." },
      { status: 429 }
    );
  }
  if (!verifyPassword(password, admin.passwordHash)) {
    const fails = noteFactorFailure(passwordKey);
    await writeAudit({
      action: "auth.2fa.rotate_denied",
      entity: "admins",
      entityId: auth.id,
      details: "Wrong password on 2FA rotation",
      adminName: auth.loginId,
      ip,
    });
    return NextResponse.json(
      { error: fails >= MAX_LOGIN_ATTEMPTS ? "Too many failed attempts. Try again in a few minutes." : "Current password is incorrect." },
      { status: 401 }
    );
  }
  clearFactorFailures(passwordKey);

  // Nothing is written here: the current factor stays live until the candidate
  // is confirmed with a code from the new authenticator.
  const secret = generateTotpSecret();
  const response = NextResponse.json({
    secret,
    otpauthUri: totpAuthUri(secret, auth.loginId),
    pending: true,
    confirmationRequired: true,
    confirmHint: "POST this endpoint with { confirm: true, code } using a code from the NEW authenticator",
    expiresInSeconds: PENDING_ENROLL_TTL_MS / 1000,
  });
  response.cookies.set(PENDING_ENROLL_COOKIE, sealPendingTotp(auth.id, "rotate", secret), pendingTotpCookieOptions());
  await writeAudit({
    action: "auth.2fa.rotate_pending",
    entity: "admins",
    entityId: auth.id,
    details: "Replacement authenticator staged — awaiting confirmation; current factor still active",
    adminName: auth.loginId,
    ip,
  });
  return response;
}
