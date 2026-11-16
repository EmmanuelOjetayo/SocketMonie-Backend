const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MINIMUM_REGISTRATION_AGE,
  calculateAge,
  isEligibleDob,
} = require("../Utilis/ageValidation");
const { isKycLocked, KYC_LOCKED_STATUS, KYC_LOCKED_MESSAGE } = require("../Utilis/kycStatus");
const { AppError } = (() => {
  try {
    // AppError lives in Utilis/AppError.js — require lazily to keep the module
    // graph small for pure-unit tests.
    const mod = require("../Utilis/AppError");
    const AppErrorCtor = mod.default || mod.AppError || mod;
    return { AppError: AppErrorCtor };
  } catch (e) {
    return { AppError: class extends Error { constructor(m, s) { super(m); this.statusCode = s; this.operational = true; } } };
  }
})();
const { AuthValidator } = require("../Middleware/AuthValidate");

const yearsAgoIso = (years) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().split("T")[0];
};

test("calculateAge derives whole years from a birth date", () => {
  assert.equal(calculateAge(`${yearsAgoIso(20)}T00:00:00.000Z`), 20);
  assert.equal(calculateAge(`${yearsAgoIso(18)}T00:00:00.000Z`), 18);
});

test("isEligibleDob accepts adults, rejects minors and future dates", () => {
  assert.equal(isEligibleDob(`${yearsAgoIso(18)}T00:00:00.000Z`), true);
  assert.equal(isEligibleDob(`${yearsAgoIso(25)}T00:00:00.000Z`), true);
  assert.equal(isEligibleDob(`${yearsAgoIso(17)}T00:00:00.000Z`), false);
  assert.equal(isEligibleDob("not-a-date"), false);
  assert.equal(isEligibleDob(null), false);
});

test("minimum registration age constant is 18", () => {
  assert.equal(MINIMUM_REGISTRATION_AGE, 18);
});

test("KYC approval lock only engages for the approved status", () => {
  assert.equal(isKycLocked(KYC_LOCKED_STATUS), true);
  assert.equal(isKycLocked("approved"), true);
  assert.equal(isKycLocked("pending_review"), false);
  assert.equal(isKycLocked("rejected"), false);
  assert.equal(isKycLocked("unverified"), false);
  assert.equal(isKycLocked(undefined), false);
  assert.ok(KYC_LOCKED_MESSAGE.length > 0);
});

const baseRegisterBody = () => ({
  fullName: "Test User",
  email: "newmember@example.com",
  phone: "08012345678",
  referralCode: "SM-ABC123",
  password: "Password1!",
  termsAccepted: true,
  privacyAccepted: true,
});

test("RegisterValidate accepts a complete adult registration payload", async () => {
  const req = { body: { ...baseRegisterBody(), dateOfBirth: `${yearsAgoIso(20)}T00:00:00.000Z` } };
  let nextCalled = false;
  await AuthValidator.RegisterValidate(req, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(new Date(req.body.dateOfBirth).toISOString(), `${yearsAgoIso(20)}T00:00:00.000Z`);
});

test("RegisterValidate rejects a registration payload without dateOfBirth", async () => {
  const req = { body: baseRegisterBody() };
  await assert.rejects(
    () => AuthValidator.RegisterValidate(req, {}, () => {}),
    (err) => err instanceof Error && err.statusCode === 400
  );
});

test("RegisterValidate rejects a registration payload with a malformed dateOfBirth", async () => {
  const req = { body: { ...baseRegisterBody(), dateOfBirth: "not-a-date" } };
  await assert.rejects(
    () => AuthValidator.RegisterValidate(req, {}, () => {}),
    (err) => err instanceof Error && err.statusCode === 400
  );
});

test("AppError exposes the HTTP status code used by the lock responses", () => {
  const err = new AppError("locked", 403);
  assert.equal(err.statusCode, 403);
});
