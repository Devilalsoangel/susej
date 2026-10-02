import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/db";
import {
  CHALLENGE_COOKIE,
  MAX_PASSWORD_LEN,
  MAX_LOGIN_ATTEMPTS,
  PENDING_ENROLL_COOKIE,
  PENDING_ENROLL_TTL_MS,
  clearedPendingTotpCookieOptions,
  clearFactorFailures,
  factorLockedOut,
  generateTotpSecret,
  getClientIp,
  noteFactorFailure,
  openPendingTotp,
  pendingTotpCookieOptions,
  protectTotpSecret,
  revealTotpSecret,
  sealPendingTotp,
  throttleTotpManagement,
  totpAuthUri,
  verifyChallengeToken,
  verifyPassword,
  verifyTotpCode,
} from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

/** Proof of the factor that is live RIGHT NOW. A live TOTP secret is checked
 *  as a TOTP code; a legacy (pre-TOTP) static code is checked as a password —
 *  same fallback verify-2fa uses, so the owner of a legacy factor is never
 *  locked out of rotating it. */
function currentFactorProofOk(code: string, stored: string | null): boolean {
  if (!stored) return false;
  const secret = revealTotpSecret(stored);
  if (secret) return verifyTotpCode(secret, code);
  return verifyPassword(code, stored);
}

/**
 * POST /api/login/enroll-2fa
 *   begin  { password, code? }        -> candidate secret (only if no live factor)
 *                                      -> PENDING candidate (never written) if a
 *                                         live factor exists and `code` proved it
 *   confirm { confirm: true, code }   -> promotes the pending candidate
 *
 * Pre-fix, ANY caller holding a pre-2FA challenge cookie + the password could
 * overwrite a WORKING authenticator in one shot: the challenge is minted BEFORE
 * the second factor is verified, so password-only access was enough to swap the
 * factor for one the attacker controls and then log straight in. The old factor
 * also died before the new one was ever proven, so an honest admin who mistyped
 * the password of a healthy factor was locked out of their own account.
 *
 * Now: over a live factor the current code is REQUIRED (budgeted), and the new
 * secret is only ever a pending cookie — the live factor keeps authenticating
 * until the candidate is confirmed with a code from the new authenticator.
 * With NO factor on the row (the enrollmentRequired dead-end recovery) there is
 * nothing to destroy, so it commits immediately and that recovery stays usable.
 */
export async function POST(request: NextRequest) {
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

  // Cheap, caller-independent first: no throttling to defeat while probing.
  const challenge = verifyChallengeToken(request.cookies.get(CHALLENGE_COOKIE)?.value);
  if (!challenge) return NextResponse.json({ error: "Your sign-in expired. Please sign in again." }, { status: 401 });

  const ip = getClientIp(request);
  if (!throttleTotpManagement(ip)) {
    return NextResponse.json({ error: "Too many attempts — wait a minute and try again." }, { status: 429 });
  }

  const prisma = await getPrisma();
  if (!prisma) return NextResponse.json({ error: "Database unavailable." }, { status: 503 });
  const admin = await prisma.admin.findUnique({ where: { id: challenge.sub } });
  if (!admin || admin.status !== "active") {
    return NextResponse.json({ error: "Invalid sign-in." }, { status: 401 });
  }

  /* ---------------- confirm: promote the pending candidate ---------------- */
  if (confirm) {
    const budgetKey = `enroll-confirm:${admin.id}`;
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "Enter the 6-digit code from your new authenticator." }, { status: 400 });
    }
    if (factorLockedOut(budgetKey)) {
      return NextResponse.json(
        { error: "Too many wrong codes. Start the setup again in a few minutes." },
        { status: 429 }
      );
    }
    const pendingSecret = openPendingTotp(request.cookies.get(PENDING_ENROLL_COOKIE)?.value, admin.id, "enroll");
    if (!pendingSecret) {
      return NextResponse.json(
        { error: "No setup in progress. Please sign in again and start the setup." },
        { status: 401 }
      );
    }
    if (!verifyTotpCode(pendingSecret, code)) {
      const fails = noteFactorFailure(budgetKey);
      const exhausted = fails >= MAX_LOGIN_ATTEMPTS;
      await writeAudit({
        action: "auth.2fa.enroll_confirm_failed",
        entity: "admins",
        entityId: admin.id,
        details: exhausted ? "2FA confirm budget exhausted — pending setup dropped" : "Wrong code confirming new authenticator",
        adminName: admin.loginId,
        ip,
      });
      const response = NextResponse.json(
        {
          error: exhausted
            ? "Too many wrong codes. Start the setup again."
            : "That code does not match the new setup key.",
        },
        { status: 401 }
      );
      if (exhausted) response.cookies.set(PENDING_ENROLL_COOKIE, "", clearedPendingTotpCookieOptions());
      return response;
    }
    clearFactorFailures(budgetKey);
    // The only write to the live factor in the pending flow — reached ONLY
    // after the candidate proved itself with a live code.
    await prisma.admin.update({
      where: { id: admin.id },
      data: { twoFactorCode: protectTotpSecret(pendingSecret), twoFactorEnabled: true },
    });
    await writeAudit({
      action: "auth.2fa.enrolled",
      entity: "admins",
      entityId: admin.id,
      details: "Authenticator enrollment created (confirmed with a live code)",
      adminName: admin.loginId,
      ip,
    });
    const response = NextResponse.json({ confirmed: true, pending: false, twoFactorEnabled: true });
    response.cookies.set(PENDING_ENROLL_COOKIE, "", clearedPendingTotpCookieOptions());
    return response;
  }

  /* ---------------------------- begin: candidate -------------------------- */
  if (!password || password.length > MAX_PASSWORD_LEN) {
    return NextResponse.json({ error: "Current password is required." }, { status: 400 });
  }
  if (!verifyPassword(password, admin.passwordHash)) {
    await writeAudit({
      action: "auth.2fa.enroll_denied",
      entity: "admins",
      entityId: admin.id,
      details: "Wrong password on authenticator enrollment",
      adminName: admin.loginId,
      ip,
    });
    return NextResponse.json({ error: "Invalid sign-in." }, { status: 401 });
  }

  const hasLiveFactor = Boolean(admin.twoFactorEnabled && admin.twoFactorCode);
  const secret = generateTotpSecret();

  if (hasLiveFactor) {
    // Re-authenticate the factor itself before touching anything.
    const budgetKey = `enroll-factor:${admin.id}`;
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json(
        { error: "Enter the current 6-digit code from your current authenticator." },
        { status: 400 }
      );
    }
    if (factorLockedOut(budgetKey)) {
      return NextResponse.json(
        { error: "Too many wrong codes. Try again in a few minutes." },
        { status: 429 }
      );
    }
    if (!currentFactorProofOk(code, admin.twoFactorCode)) {
      const fails = noteFactorFailure(budgetKey);
      await writeAudit({
        action: "auth.2fa.enroll_denied",
        entity: "admins",
        entityId: admin.id,
        details: "Wrong current authenticator code on replacement enrollment",
        adminName: admin.loginId,
        ip,
      });
      return NextResponse.json(
        { error: fails >= MAX_LOGIN_ATTEMPTS ? "Too many wrong codes. Try again in a few minutes." : "That code is not from your current authenticator." },
        { status: 401 }
      );
    }
    clearFactorFailures(budgetKey);
    // Nothing written: the current factor stays live until the candidate is
    // confirmed with a code from the NEW authenticator.
    const response = NextResponse.json({
      secret,
      otpauthUri: totpAuthUri(secret, admin.loginId),
      pending: true,
      confirmationRequired: true,
      twoFactorEnabled: admin.twoFactorEnabled,
      confirmHint: "POST this endpoint with { confirm: true, code } using a code from the NEW authenticator",
      expiresInSeconds: PENDING_ENROLL_TTL_MS / 1000,
    });
    response.cookies.set(PENDING_ENROLL_COOKIE, sealPendingTotp(admin.id, "enroll", secret), pendingTotpCookieOptions());
    await writeAudit({
      action: "auth.2fa.enroll_pending",
      entity: "admins",
      entityId: admin.id,
      details: "Replacement authenticator staged — awaiting confirmation; current factor still active",
      adminName: admin.loginId,
      ip,
    });
    return response;
  }

  // No factor on the row (fresh or enrollmentRequired dead end): there is no
  // working factor to protect, so commit directly and keep that recovery usable.
  await prisma.admin.update({
    where: { id: admin.id },
    data: { twoFactorCode: protectTotpSecret(secret), twoFactorEnabled: true },
  });
  await writeAudit({
    action: "auth.2fa.enrolled",
    entity: "admins",
    entityId: admin.id,
    details: "Authenticator enrollment created",
    adminName: admin.loginId,
    ip,
  });
  return NextResponse.json({ secret, otpauthUri: totpAuthUri(secret, admin.loginId), pending: false, twoFactorEnabled: true });
}
