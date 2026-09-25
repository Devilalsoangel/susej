import test from "node:test";
import assert from "node:assert/strict";
import { canonPhone, devOtpExposureAllowed, isIndianPhoneShape } from "./app-auth";

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
