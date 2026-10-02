import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  APP_OTP_MAX_ATTEMPTS,
  APP_OTP_SEND_WINDOW_MS,
  authOtpPepperMissing,
  authPhoneLockKey,
  canonPhone,
  challengeIntentsMatch,
  devOtpExposureAllowed,
  hashOtpCode,
  isIndianPhoneShape,
  otpPepper,
  otpRowState,
  otpTombstoneValue,
  parseAppAuthBody,
  parseAppPhone,
  parseAuthIntent,
  parseOtpCode,
  parseSendAuthIntent,
  parseStoredAuthIntent,
  parseVerifyAuthIntent,
  phoneVerificationAction,
  readOtpAttempts,
  readOtpSendWindow,
  resolvePhoneVerificationAction,
  verifyOtpCode,
} from "./app-auth";

test("phone shapes remain India-only and canonical", () => {
  assert.equal(isIndianPhoneShape("9876543210"), true);
  assert.equal(isIndianPhoneShape("919876543210"), true);
  assert.equal(isIndianPhoneShape("09876543210"), true);
  assert.equal(isIndianPhoneShape("14155552671"), false);
  assert.equal(canonPhone("09876543210"), "919876543210");
  assert.equal(canonPhone("+91 98765 43210"), "919876543210");
});

test("development OTP exposure is available for local testing", () => {
  assert.equal(devOtpExposureAllowed("9876543210", { NODE_ENV: "development", AUTH_DEV_MODE: "1" }), true);
  assert.equal(devOtpExposureAllowed("9876543210", { NODE_ENV: "development", AUTH_DEV_MODE: "0" }), false);
});

test("production OTP exposure cannot be enabled by AUTH_DEV_MODE alone", () => {
  assert.equal(
    devOtpExposureAllowed("9876543210", {
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      AUTH_DEV_MODE: "1",
    }),
    false
  );
});

test("preview OTP exposure is limited to the test phone allowlist", () => {
  const env = {
    NODE_ENV: "production",
    VERCEL_ENV: "preview",
    AUTH_DEV_MODE: "1",
    AUTH_DEV_TEST_PHONES: "9876543210, 9000000000",
  };
  assert.equal(devOtpExposureAllowed("+91 98765 43210", env), true);
  assert.equal(devOtpExposureAllowed("9000000000", env), true);
  assert.equal(devOtpExposureAllowed("9999999999", env), false);
});

test("phone verification keeps create intent away from existing accounts", () => {
  assert.equal(phoneVerificationAction(true, false), "sign-in");
  assert.equal(phoneVerificationAction(true, true), "account-exists");
  assert.equal(phoneVerificationAction(false, false), "needs-signup");
  assert.equal(phoneVerificationAction(false, true), "create");
});

test("account truth table resolves from existence and explicit intent", () => {
  const actions = [
    [true, "login", "sign-in"],
    [true, "signup", "account-exists"],
    [false, "login", "needs-signup"],
    [false, "signup", "create"],
  ] as const;
  for (const [exists, intent, expected] of actions) {
    assert.equal(phoneVerificationAction(exists, intent === "signup"), expected);
  }
});

test("auth intent accepts only login and signup", () => {
  assert.equal(parseAuthIntent("login"), "login");
  assert.equal(parseAuthIntent("signup"), "signup");
  assert.equal(parseAuthIntent("register"), null);
  assert.equal(parseAuthIntent("Login"), null);
  assert.equal(parseAuthIntent(true), null);
  assert.equal(parseAuthIntent(undefined), null);
  assert.equal(parseAuthIntent(null), null);
});

test("legacy challenge rows map create flag to an intent", () => {
  assert.equal(parseStoredAuthIntent(undefined, true), "signup");
  assert.equal(parseStoredAuthIntent(undefined, false), "login");
  assert.equal(parseStoredAuthIntent(undefined, undefined), "login");
  assert.equal(parseStoredAuthIntent("login", true), "login");
  assert.equal(parseStoredAuthIntent("signup", true), "signup");
  assert.equal(parseStoredAuthIntent("auto", true), null);
  assert.equal(parseStoredAuthIntent(null, false), null);
  assert.equal(parseStoredAuthIntent(1, true), null);
});

test("challenge intent must match the issued intent", () => {
  assert.equal(challengeIntentsMatch("login", "login"), true);
  assert.equal(challengeIntentsMatch("signup", "signup"), true);
  assert.equal(challengeIntentsMatch("login", "signup"), false);
  assert.equal(challengeIntentsMatch("signup", "login"), false);
});

test("phone parsing fails closed on non-strings and foreign shapes", () => {
  assert.equal(parseAppPhone("9876543210"), "919876543210");
  assert.equal(parseAppPhone("+91 98765 43210"), "919876543210");
  assert.equal(parseAppPhone("09876543210"), "919876543210");
  assert.equal(parseAppPhone(9876543210), null);
  assert.equal(parseAppPhone(null), null);
  assert.equal(parseAppPhone(undefined), null);
  assert.equal(parseAppPhone({}), null);
  assert.equal(parseAppPhone(""), null);
  assert.equal(parseAppPhone("98765"), null);
  assert.equal(parseAppPhone("9876543210123"), null);
  assert.equal(parseAppPhone("14155552671"), null);
  assert.equal(parseAppPhone("abcdefghij"), null);
});

test("otp codes accept exactly six digits", () => {
  assert.equal(parseOtpCode("012345"), "012345");
  assert.equal(parseOtpCode("123456"), "123456");
  assert.equal(parseOtpCode("12345"), null);
  assert.equal(parseOtpCode("1234567"), null);
  assert.equal(parseOtpCode("12345a"), null);
  assert.equal(parseOtpCode(" 123456"), null);
  assert.equal(parseOtpCode("123 456"), null);
  assert.equal(parseOtpCode(123456), null);
  assert.equal(parseOtpCode(null), null);
});

test("request bodies accept only plain objects", () => {
  assert.deepEqual(parseAppAuthBody({ phone: "9876543210" }), { phone: "9876543210" });
  assert.deepEqual(parseAppAuthBody(null), {});
  assert.deepEqual(parseAppAuthBody(undefined), {});
  assert.deepEqual(parseAppAuthBody("phone"), {});
  assert.deepEqual(parseAppAuthBody(7), {});
  assert.deepEqual(parseAppAuthBody([{ phone: "9876543210" }]), {});
});

test("a pre-change send without intent stores a legacy wildcard challenge", () => {
  assert.equal(parseSendAuthIntent(undefined, undefined), "legacy");
  assert.equal(parseSendAuthIntent(undefined, false), "legacy");
  assert.equal(parseSendAuthIntent(undefined, true), "legacy");
  assert.equal(parseSendAuthIntent("login", undefined), "login");
  assert.equal(parseSendAuthIntent("signup", true), "signup");
  assert.equal(parseSendAuthIntent("login", true), "login");
  assert.equal(parseSendAuthIntent("register", undefined), null);
  assert.equal(parseSendAuthIntent("Login", undefined), null);
  assert.equal(parseSendAuthIntent(undefined, "true"), null);
  assert.equal(parseSendAuthIntent(undefined, 1), null);
  assert.equal(parseSendAuthIntent(undefined, null), null);
});

test("verify accepts the pre-change create flag and the new intent", () => {
  assert.equal(parseVerifyAuthIntent(undefined, true), "signup");
  assert.equal(parseVerifyAuthIntent(undefined, false), "login");
  assert.equal(parseVerifyAuthIntent(undefined, undefined), "login");
  assert.equal(parseVerifyAuthIntent("login", undefined), "login");
  assert.equal(parseVerifyAuthIntent("signup", undefined), "signup");
  assert.equal(parseVerifyAuthIntent("signup", true), "signup");
  assert.equal(parseVerifyAuthIntent("login", true), "login");
  assert.equal(parseVerifyAuthIntent("signup", false), "signup");
  assert.equal(parseVerifyAuthIntent("register", undefined), null);
  assert.equal(parseVerifyAuthIntent(undefined, "yes"), null);
  assert.equal(parseVerifyAuthIntent(undefined, null), null);
});

test("a wildcard challenge matches either intent while explicit challenges bind exactly", () => {
  assert.equal(parseStoredAuthIntent("legacy", undefined), "legacy");
  assert.equal(parseStoredAuthIntent("*", undefined), "legacy");
  assert.equal(challengeIntentsMatch("legacy", "login"), true);
  assert.equal(challengeIntentsMatch("legacy", "signup"), true);
  assert.equal(challengeIntentsMatch("login", "login"), true);
  assert.equal(challengeIntentsMatch("signup", "signup"), true);
  assert.equal(challengeIntentsMatch("login", "signup"), false);
  assert.equal(challengeIntentsMatch("signup", "login"), false);
  assert.equal(parseStoredAuthIntent("login", true), "login");
  assert.equal(parseStoredAuthIntent("signup", false), "signup");
  assert.equal(parseStoredAuthIntent("auto", false), null);
  assert.equal(parseStoredAuthIntent("login", "yes"), null);
});

test("the account truth table resolves legacy and dual-sent challenges", () => {
  assert.equal(resolvePhoneVerificationAction(true, "legacy", "login"), "sign-in");
  assert.equal(resolvePhoneVerificationAction(false, "legacy", "login"), "needs-signup");
  assert.equal(resolvePhoneVerificationAction(true, "legacy", "signup"), "account-exists");
  assert.equal(resolvePhoneVerificationAction(false, "legacy", "signup"), "create");
  assert.equal(resolvePhoneVerificationAction(true, "login", "login"), "sign-in");
  assert.equal(resolvePhoneVerificationAction(true, "signup", "signup"), "account-exists");
  assert.equal(resolvePhoneVerificationAction(false, "signup", "signup"), "create");
  assert.equal(resolvePhoneVerificationAction(true, "login", "signup"), "intent-mismatch");
  assert.equal(resolvePhoneVerificationAction(false, "signup", "login"), "intent-mismatch");
});

test("peppered otp hashes are canonical and verify only the right code", () => {
  const env = { AUTH_OTP_PEPPER: "pepper-value" };
  const hash = hashOtpCode("9876543210", "123456", env);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, createHash("sha256").update("919876543210:123456").digest("hex"));
  assert.equal(hashOtpCode("+91 98765 43210", "123456", env), hash);
  assert.equal(verifyOtpCode("919876543210", "123456", hash, env), true);
  assert.equal(verifyOtpCode("919876543210", "654321", hash, env), false);
  assert.equal(verifyOtpCode("919876543211", "123456", hash, env), false);
});

test("legacy sha256 challenges are rejected once a pepper is configured", () => {
  const legacy = createHash("sha256").update("919876543210:445566").digest("hex");
  // A configured pepper means every row must be keyed: an unsalted row sitting
  // next to the phone number is offline-crackable in 1e6 tries, so accepting it
  // would undo the pepper for any row that predates it.
  assert.equal(verifyOtpCode("9876543210", "445566", legacy, { AUTH_OTP_PEPPER: "pepper-value" }), false);
  assert.equal(verifyOtpCode("9876543210", "445566", legacy, { AUTH_OTP_PEPPER: "pepper-value", JWT_SECRET: "jwt" }), false);
  // Dev/test keeps the legacy lane so pre-existing local rows still verify.
  assert.equal(verifyOtpCode("9876543210", "445566", legacy, {}), true);
  assert.equal(verifyOtpCode("9876543210", "445567", legacy, {}), false);
  // A jwt-derived key is still a key: the pepper requirement is about
  // production config, not about accepting keyed hashes in dev.
  const jwt = { JWT_SECRET: "jwt-secret" };
  const jwtHash = hashOtpCode("9876543210", "445566", jwt);
  assert.equal(verifyOtpCode("9876543210", "445566", jwtHash, jwt), true);
  // With no pepper anywhere (dev) the legacy lane is still open, so a row
  // written before any secret existed keeps working locally.
  assert.equal(verifyOtpCode("9876543210", "445566", legacy, jwt), true);
});

test("production refuses to run the otp flow without any keyed secret", () => {
  assert.equal(authOtpPepperMissing({ NODE_ENV: "production" }), true);
  assert.equal(authOtpPepperMissing({ NODE_ENV: "production", VERCEL_ENV: "production" }), true);
  assert.equal(authOtpPepperMissing({ NODE_ENV: "production", AUTH_OTP_PEPPER: "", JWT_SECRET: "" }), true);
  // JWT_SECRET is the already-provisioned deployment secret, so a deploy that
  // has not added AUTH_OTP_PEPPER yet still gets a keyed HMAC and a working OTP.
  assert.equal(authOtpPepperMissing({ NODE_ENV: "production", JWT_SECRET: "a".repeat(64) }), false);
  assert.equal(
    authOtpPepperMissing({ NODE_ENV: "production", VERCEL_ENV: "production", AUTH_OTP_PEPPER: "pepper-value" }),
    false
  );
  // Preview is the dev-OTP lane: it only needs SOME key, so devCode testing
  // survives, but the unsalted branch stays unreachable on a deployed host.
  assert.equal(authOtpPepperMissing({ NODE_ENV: "production", VERCEL_ENV: "preview" }), true);
  assert.equal(authOtpPepperMissing({ NODE_ENV: "production", VERCEL_ENV: "preview", JWT_SECRET: "jwt" }), false);
  assert.equal(
    authOtpPepperMissing({ NODE_ENV: "production", VERCEL_ENV: "preview", AUTH_OTP_PEPPER: "pepper-value" }),
    false
  );
  // Dev/test and preview builds are never blocked — local OTP testing stays live.
  assert.equal(authOtpPepperMissing({}), false);
  assert.equal(authOtpPepperMissing({ NODE_ENV: "development" }), false);
  assert.equal(authOtpPepperMissing({ NODE_ENV: "test" }), false);
  assert.equal(otpPepper({ AUTH_OTP_PEPPER: "p" }), "p");
  assert.equal(otpPepper({ AUTH_OTP_PEPPER: "" }), null);
  assert.equal(otpPepper({}), null);
});

test("otp hashing prefers the pepper, then jwt secret, then legacy sha", () => {
  const jwt = { JWT_SECRET: "jwt-secret" };
  const jwtHash = hashOtpCode("9876543210", "112233", jwt);
  assert.notEqual(jwtHash, createHash("sha256").update("919876543210:112233").digest("hex"));
  assert.equal(verifyOtpCode("9876543210", "112233", jwtHash, jwt), true);
  assert.notEqual(jwtHash, hashOtpCode("9876543210", "112233", { AUTH_OTP_PEPPER: "pepper-value" }));
  const noSecret = hashOtpCode("9876543210", "112233", {});
  assert.equal(noSecret, createHash("sha256").update("919876543210:112233").digest("hex"));
  assert.equal(verifyOtpCode("9876543210", "112233", noSecret, {}), true);
});

test("otp verification fails closed on malformed or altered stored hashes", () => {
  const env = { AUTH_OTP_PEPPER: "pepper-value" };
  const hash = hashOtpCode("9876543210", "778899", env);
  const altered = `${hash.slice(0, -1)}${hash.endsWith("a") ? "b" : "a"}`;
  assert.equal(verifyOtpCode("9876543210", "778899", altered, env), false);
  assert.equal(verifyOtpCode("9876543210", "778899", "", env), false);
  assert.equal(verifyOtpCode("9876543210", "778899", "zz", env), false);
  assert.equal(verifyOtpCode("9876543210", "778899", null, env), false);
});

test("the auth advisory lock key is canonical across phone formats", () => {
  assert.equal(authPhoneLockKey("9876543210"), "app-auth:919876543210");
  assert.equal(authPhoneLockKey("+91 98765 43210"), "app-auth:919876543210");
  assert.equal(authPhoneLockKey("09876543210"), `app-auth:${canonPhone("09876543210")}`);
});

/* ------------------------------------------------------------------ *
 * Burn-path tombstones: the send limiter must survive every way a code
 * can stop verifying (expiry, attempt-lock, successful use).
 * ------------------------------------------------------------------ */

const HOUR = 60 * 60 * 1000;
const env = { AUTH_OTP_PEPPER: "pepper-value" };

function liveRow(now: number) {
  return {
    hash: hashOtpCode("919876543210", "123456", env),
    exp: now + 5 * 60 * 1000,
    attempts: 0,
    issuedAt: now,
    sent: 1,
    firstSent: now,
    intent: "login",
    state: "active",
  };
}

test("row state separates a live challenge from every terminal tombstone", () => {
  assert.equal(otpRowState({}), "active");
  assert.equal(otpRowState({ state: "active" }), "active");
  assert.equal(otpRowState({ state: "spent" }), "spent");
  assert.equal(otpRowState({ state: "expired" }), "expired");
  assert.equal(otpRowState({ state: "locked" }), "locked");
  // Unknown/malformed state must not read as a live challenge.
  assert.equal(otpRowState({ state: "ACTIVE" }), "active");
  assert.equal(otpRowState({ state: "consumed" }), "active");
  assert.equal(otpRowState({ state: 7 }), "active");
  assert.equal(otpRowState({ state: null }), "active");
});

test("a burn keeps the send limiter and drops only the verifiable code", () => {
  const now = 1_800_000_000_000;
  for (const state of ["spent", "expired", "locked"] as const) {
    const row = liveRow(now);
    const stone = otpTombstoneValue(row, state, now) as Record<string, unknown>;
    // Nothing left to verify or replay.
    assert.equal(stone.hash, "", `${state} must not keep a hash`);
    assert.equal(readOtpAttempts(stone), state === "locked" ? APP_OTP_MAX_ATTEMPTS : 0);
    // The limiter rides along untouched — this is the fix.
    assert.equal(stone.sent, 1, `${state} must preserve sent`);
    assert.equal(stone.firstSent, now, `${state} must preserve firstSent`);
    assert.equal(stone.state, state);
    assert.equal(stone.issuedAt, now);
    assert.equal(stone.consumedAt, now);
    assert.equal(stone.intent, "login");
    assert.equal(readOtpSendWindow(stone, now + 1000).sentInWindow, 1);
    assert.equal(verifyOtpCode("919876543210", "123456", stone.hash, env), false);
  }
});

test("an expired tombstone cannot fake a live cooldown, a locked one keeps it", () => {
  const now = 1_800_000_000_000;
  const row = { ...liveRow(now), exp: now - 1, attempts: APP_OTP_MAX_ATTEMPTS };
  const expired = otpTombstoneValue(row, "expired", now) as Record<string, unknown>;
  // exp must be in the past or the send route reports "code already sent" for
  // a code that no longer exists.
  assert.ok((expired.exp as number) <= now);
  const locked = otpTombstoneValue({ ...liveRow(now), attempts: APP_OTP_MAX_ATTEMPTS }, "locked", now) as Record<string, unknown>;
  assert.ok((locked.exp as number) > now, "a fresh lock still holds its 45s cooldown");
  // Malformed numbers never resurrect a window or a code.
  const garbage = otpTombstoneValue({ hash: "x", exp: "soon", sent: "many", firstSent: null, intent: 5 }, "spent", now) as Record<string, unknown>;
  assert.equal(garbage.hash, "");
  assert.equal(garbage.sent, 0);
  assert.equal(garbage.firstSent, now);
  assert.equal(garbage.exp, now);
  assert.equal("intent" in garbage, false);
});

test("burning codes all day can never buy the caller a fresh hourly budget", () => {
  // Reproduces the reported bypass at the arithmetic level. The old verify
  // route DELETEd the row on expiry / lock / success, so the send route read
  // sent=0 and firstSent=now -> a fresh 5-code budget every cycle, forever.
  // `deleteLimiter` is that old behaviour, kept here only as the contrast.
  const runPump = (deleteLimiter: boolean) => {
    const now = 1_800_000_000_000;
    let row: Record<string, unknown> = { ...liveRow(now), sent: 5, attempts: APP_OTP_MAX_ATTEMPTS };
    let issued = 0;
    let windowStart = row.firstSent as number;
    let inWindow = 0;
    let peak = 0;
    for (let cycle = 0; cycle < 50; cycle += 1) {
      const at = now + cycle * 2 * 60 * 1000; // every 2 minutes, past the 45s cooldown
      // --- send route: cooldown check, then rolling-hour budget ---
      const prevExp = row.exp as number;
      const prevIssuedAt = row.issuedAt as number;
      if (prevExp > at && at - prevIssuedAt < 45_000) continue;
      const window = deleteLimiter
        ? { sentInWindow: 0, firstSent: at }
        : readOtpSendWindow(row, at);
      if (window.sentInWindow >= 5) continue;
      issued += 1;
      inWindow += 1;
      peak = Math.max(peak, inWindow);
      row = {
        hash: hashOtpCode("919876543210", String(100000 + cycle), env),
        exp: at + 5 * 60 * 1000,
        attempts: 0,
        issuedAt: at,
        sent: window.sentInWindow + 1,
        firstSent: window.firstSent,
        intent: "login",
        state: "active",
      };
      // --- verify route: burn all five attempts -> locked tombstone ---
      for (let attempt = 0; attempt < APP_OTP_MAX_ATTEMPTS; attempt += 1) {
        row = { ...row, attempts: readOtpAttempts(row) + 1 } as Record<string, unknown>;
      }
      if (!deleteLimiter) {
        const sentBeforeBurn = row.sent;
        const firstSentBeforeBurn = row.firstSent;
        row = otpTombstoneValue(row, "locked", at) as Record<string, unknown>;
        assert.equal(otpRowState(row), "locked");
        // The burn is a no-op for the limiter: exactly the delete bug fixed.
        assert.equal(row.sent, sentBeforeBurn, "a locked burn must keep the hour counted");
        assert.equal(row.firstSent, firstSentBeforeBurn, "a locked burn must not restart the hour");
        assert.equal(row.hash, "");
      }
      if (at - windowStart >= HOUR) {
        peak = Math.max(peak, inWindow);
        windowStart = at;
        inWindow = 0;
      }
    }
    return { issued, peak };
  };

  const fixed = runPump(false);
  // 50 pump attempts over 100 minutes, at most 5 codes per rolling hour.
  assert.ok(fixed.peak <= 5, `hourly cap broken: ${fixed.peak} in one window`);
  assert.ok(fixed.issued <= 10, `50 pump attempts issued ${fixed.issued} codes`);
  // The pre-fix arithmetic issues on every cycle (only the 45s cooldown
  // swallows the first) — that is the bypass itself.
  assert.ok(runPump(true).issued >= 49, "delete semantics should have issued ~50 codes");
});

test("successful single-use burns also charge the hourly budget", () => {
  const now = 1_800_000_000_000;
  const spent = otpTombstoneValue({ ...liveRow(now), attempts: 2 }, "spent", now + 1000) as Record<string, unknown>;
  // Single-use still holds: the spent tombstone can never verify.
  assert.equal(verifyOtpCode("919876543210", "123456", spent.hash, env), false);
  // And the code that was sent is still counted, so sign-in is not a free pump.
  assert.equal(readOtpSendWindow(spent, now + 60_000).sentInWindow, 1);
});

test("send-window reads are total over junk, stale and future markers", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(readOtpSendWindow({}, now), { sentInWindow: 0, firstSent: now });
  assert.deepEqual(readOtpSendWindow({ sent: "3", firstSent: "x" }, now), { sentInWindow: 0, firstSent: now });
  assert.deepEqual(readOtpSendWindow({ sent: -9, firstSent: now }, now), { sentInWindow: 0, firstSent: now });
  assert.deepEqual(readOtpSendWindow({ sent: 2.9, firstSent: now }, now), { sentInWindow: 2, firstSent: now });
  // A firstSent skewed into the future is treated as an OPEN window with its
  // budget still charged (fail closed). It must never be read as a fresh
  // window — that is the direction the bypass lived in.
  assert.deepEqual(readOtpSendWindow({ sent: 4, firstSent: now + 10 * HOUR }, now), {
    sentInWindow: 4,
    firstSent: now + 10 * HOUR,
  });
  // The window does reopen once an hour has genuinely passed.
  assert.deepEqual(readOtpSendWindow({ sent: 5, firstSent: now }, now + HOUR), {
    sentInWindow: 0,
    firstSent: now + HOUR,
  });
  assert.equal(readOtpAttempts({ attempts: -4 }), 0);
  assert.equal(readOtpAttempts({ attempts: 3.7 }), 3);
  assert.equal(readOtpAttempts({ attempts: "3" }), 0);
  assert.equal(APP_OTP_SEND_WINDOW_MS, HOUR);
  assert.equal(APP_OTP_MAX_ATTEMPTS, 5);
});
