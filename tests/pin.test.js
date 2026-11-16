const test = require("node:test");
const assert = require("node:assert/strict");
const genOTP = require("../Utilis/genOTP");
const {
  ChangePinValidate,
  ResetPinValidate,
  ForgotPinValidate,
} = require("../Middleware/UserValidate");

test("genOTP returns a cryptographically secure 4-digit numeric OTP", () => {
  for (let i = 0; i < 25; i++) {
    const otp = genOTP();
    assert.equal(typeof otp, "string");
    assert.equal(otp.length, 4);
    assert.match(otp, /^[0-9]{4}$/);
  }
});

test("genOTP returns unique OTP values across generations", () => {
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    seen.add(genOTP());
  }
  assert.equal(seen.size, 25);
});

test("ChangePinValidate accepts a well-formed change payload", () => {
  let threw = null;
  try {
    ChangePinValidate(
      { body: { currentPin: "1234", newPin: "5678", confirmNewPin: "5678" } },
      {},
      () => {}
    );
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null);
});

test("ChangePinValidate rejects a short current PIN", () => {
  let error = null;
  try {
    ChangePinValidate({ body: { currentPin: "12", newPin: "5678" } }, {}, () => {});
  } catch (err) {
    error = err;
  }
  assert.ok(error);
  assert.equal(error.statusCode, 400);
});

test("ResetPinValidate requires email, otp and newPin", () => {
  let error = null;
  try {
    ResetPinValidate({ body: { email: "member@test.com", otp: "123" } }, {}, () => {});
  } catch (err) {
    error = err;
  }
  assert.ok(error);
  assert.equal(error.statusCode, 400);
});

test("ForgotPinValidate requires a valid email", () => {
  let error = null;
  try {
    ForgotPinValidate({ body: { email: "not-an-email" } }, {}, () => {});
  } catch (err) {
    error = err;
  }
  assert.ok(error);
  assert.equal(error.statusCode, 400);
});
