const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

const { toSafeUserPayload } = require("../Utilis/userPayload");
const { buildKycStatusUpdate } = require("../Utilis/kycStatus");
const { verifyTransactionPin } = require("../Utilis/pinVerification");
const UserValidator = require("../Middleware/UserValidate");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const loadAppError = () => {
  const mod = require("../Utilis/AppError");
  return mod.default || mod.AppError || mod;
};

test("safe user payloads expose KYC status but never identity number or document", () => {
  const safe = toSafeUserPayload({
    _id: "user-1",
    kycStatus: "approved",
    nin: "12345678901",
    documentType: "nin",
    documentUrl: "https://res.cloudinary.com/example/kyc.pdf",
    transactionPin: "hashed-pin",
    pinResetOTP: "hashed-otp",
  });

  assert.equal(safe.kycStatus, "approved");
  assert.equal(safe.kycSubmitted, true);
  assert.equal(Object.hasOwn(safe, "nin"), false);
  assert.equal(Object.hasOwn(safe, "documentType"), false);
  assert.equal(Object.hasOwn(safe, "documentUrl"), false);
  assert.equal(Object.hasOwn(safe, "transactionPin"), false);
  assert.equal(Object.hasOwn(safe, "pinResetOTP"), false);

  const empty = toSafeUserPayload({ kycStatus: "unverified" });
  assert.equal(empty.kycSubmitted, false);
});

test("VerifyPinValidate accepts only a 4-digit transaction PIN", () => {
  const valid = { body: { pin: "1234" } };
  let nextCalled = false;
  UserValidator.VerifyPinValidate(valid, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.deepEqual(valid.body, { pin: "1234" });

  for (const pin of ["123", "12a4", "12345", undefined]) {
    assert.throws(
      () => UserValidator.VerifyPinValidate({ body: pin ? { pin } : {} }, {}, () => {}),
      (err) => err instanceof Error && err.statusCode === 400
    );
  }
});

test("transaction PIN verification uses the bcrypt hash and rejects bad or unset PINs", async () => {
  const hash = await bcrypt.hash("1234", 10);
  const AppError = loadAppError();

  assert.equal(await verifyTransactionPin("1234", { transactionPin: hash }), true);

  await assert.rejects(
    () => verifyTransactionPin("9999", { transactionPin: hash }),
    (err) => err instanceof AppError && err.statusCode === 400 && /invalid transaction pin/i.test(err.message)
  );

  await assert.rejects(
    () => verifyTransactionPin("1234", { transactionPin: null }),
    (err) => err instanceof AppError && err.statusCode === 400 && /pin not set/i.test(err.message)
  );
});

test("admin approval transition syncs kycStatus on the member document", () => {
  const AppError = loadAppError();
  const submitted = { documentUrl: "https://res.cloudinary.com/example/kyc.pdf" };

  assert.throws(
    () => buildKycStatusUpdate("approved", "", { documentUrl: null }),
    (err) => err instanceof AppError && err.statusCode === 400 && /no kyc document/i.test(err.message)
  );

  const approved = buildKycStatusUpdate("approved", "old reason", submitted);
  assert.equal(approved.kycStatus, "approved");
  assert.ok(approved.kycVerifiedAt instanceof Date);
  assert.equal(approved.kycRejectionReason, null);

  const rejected = buildKycStatusUpdate("rejected", "NIN was unclear", submitted);
  assert.equal(rejected.kycStatus, "rejected");
  assert.equal(rejected.kycRejectionReason, "NIN was unclear");
  assert.equal(rejected.kycVerifiedAt, null);

  const pending = buildKycStatusUpdate("pending_review", "", submitted);
  assert.equal(pending.kycStatus, "pending_review");
  assert.equal(pending.kycVerifiedAt, null);
  assert.equal(pending.kycRejectionReason, null);
});

test("KYC routes enforce authentication, PIN validation and a rate limit", () => {
  const routes = read("Routes/UserRoutes.js");
  const viewLine = routes
    .split("\n")
    .find((line) => line.includes("UserRoutes.post('/kyc/view'"));

  assert.ok(viewLine, "PIN-protected KYC view route is missing");
  assert.ok(viewLine.includes("routeProtect"));
  assert.ok(viewLine.includes("UserValidator.VerifyPinValidate"));
  assert.ok(viewLine.includes("financialLimiter"));
  assert.ok(viewLine.includes("ViewKycDetails"));
  assert.ok(!viewLine.includes("req.params"), "the view route must not accept a target user");
  assert.ok(!/UserRoutes\.get\(['"]\/kyc/.test(routes), "no unprotected KYC GET route may exist");

  const userService = read("Services/UserService.js");
  assert.ok(userService.includes("toSafeUserPayload(userData)"));
  const viewService = userService.slice(
    userService.indexOf("const ViewKycService"),
    userService.indexOf("const SetPinService")
  );
  assert.ok(viewService.includes("await verifyTransactionPin(pin, pinRecord)"));
  assert.ok(viewService.indexOf("verifyTransactionPin(pin, pinRecord)") < viewService.indexOf("findUserDetails(reqUserID"));
  assert.ok(viewService.includes("findUserDetails(reqUserID, { includeSensitive: true })"));
  assert.ok(!viewService.includes("console.log"), "the KYC view service must not log PINs or KYC payloads");

  const adminService = read("Services/AdminService.js");
  assert.ok(adminService.includes("Object.assign(user, buildKycStatusUpdate(status, reason, user))"));
  const kycStatusUtil = read("Utilis/kycStatus.js");
  assert.ok(kycStatusUtil.includes("status === KYC_LOCKED_STATUS && !user.documentUrl"));
  assert.ok(kycStatusUtil.includes("kycVerifiedAt: status === KYC_LOCKED_STATUS ? new Date() : null"));
  assert.ok(kycStatusUtil.includes('kycRejectionReason: status === "rejected" ? reason : null'));

  const adminController = read("Controllers/AdminController.js");
  assert.ok(adminController.includes("data: { kyc }"));
});
