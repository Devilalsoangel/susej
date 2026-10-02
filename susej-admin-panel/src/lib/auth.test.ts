import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const secret = "a".repeat(64);
const admin = { id: "adm_test", name: "Test Admin", role: "super_admin", loginId: "testadmin" };
let auth: typeof import("./auth");

before(async () => {
  process.env.JWT_SECRET = secret;
  auth = await import("./auth");
});

test("a signed session verifies only as a session", () => {
  const token = auth.signSession(admin, "password-hash");
  const session = auth.verifySessionToken(token);
  assert.equal(session?.typ, "admin-session");
  assert.equal(session?.aud, "susej-admin");
  assert.equal(session?.sub, admin.id);
  assert.equal(auth.verifyChallengeToken(token), null);
});

test("a pre-2FA challenge verifies only as a challenge", () => {
  const token = auth.signChallenge(admin);
  const challenge = auth.verifyChallengeToken(token);
  assert.equal(challenge?.typ, "admin-2fa");
  assert.equal(challenge?.aud, "susej-admin-2fa");
  assert.equal(challenge?.sub, admin.id);
  assert.ok(challenge?.jti);
  assert.equal(auth.verifySessionToken(token), null);
});

test("legacy typeless session tokens are rejected", () => {
  const body = Buffer.from(
    JSON.stringify({
      sub: admin.id,
      name: admin.name,
      role: admin.role,
      loginId: admin.loginId,
      exp: Date.now() + 60_000,
      iat: Date.now(),
    })
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update("session.")
    .update(body)
    .digest("base64url");
  assert.equal(auth.verifySessionToken(`${body}.${signature}`), null);
});

test("tampered session tokens are rejected", () => {
  const token = auth.signSession(admin, "password-hash");
  const [body, signature] = token.split(".");
  const changedBody = `${body[0] === "A" ? "B" : "A"}${body.slice(1)}`;
  const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.equal(auth.verifySessionToken(`${changedBody}.${signature}`), null);
  assert.equal(auth.verifySessionToken(`${body}.${changedSignature}`), null);
});

test("TOTP secrets encrypt, reveal, and verify with a one-step clock window", () => {
  const secret = auth.generateTotpSecret();
  const now = 1_800_000_000_000;
  const code = auth.totpCode(secret, now);
  assert.ok(code && /^\d{6}$/.test(code));
  assert.equal(auth.verifyTotpCode(secret, code!, now), true);
  assert.equal(auth.verifyTotpCode(secret, code!, now - 30_000), true);
  assert.equal(auth.verifyTotpCode(secret, code!, now + 90_000), false);
  const protectedSecret = auth.protectTotpSecret(secret);
  assert.notEqual(protectedSecret, secret);
  assert.equal(auth.revealTotpSecret(protectedSecret), secret);
  assert.equal(auth.revealTotpSecret("legacy:hash"), null);
});

test("seeded admins derive distinct authenticator secrets", () => {
  const first = auth.deriveTotpSecret("shared-seed", "admin-one");
  const second = auth.deriveTotpSecret("shared-seed", "admin-two");
  assert.notEqual(first, second);
  assert.ok(auth.totpCode(first, 1_800_000_000_000));
  assert.ok(auth.totpCode(second, 1_800_000_000_000));
});
