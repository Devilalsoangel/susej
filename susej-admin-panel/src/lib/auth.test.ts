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
  assert.equal(auth.verifySessionToken(`${body}x.${signature}`), null);
  assert.equal(auth.verifySessionToken(`${body}.${signature.slice(0, -1)}x`), null);
});
