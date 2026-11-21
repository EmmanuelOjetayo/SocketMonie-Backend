const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { AuthValidator } = require("../Middleware/AuthValidate");
const UserValidator = require("../Middleware/UserValidate");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const yearsAgoIso = (years) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().split("T")[0];
};

const baseRegisterBody = () => ({
  fullName: "Test User",
  email: "ninonly@example.com",
  phone: "08012345678",
  referralCode: "SM-ABC123",
  password: "Password1!",
  termsAccepted: true,
  privacyAccepted: true,
  dateOfBirth: `${yearsAgoIso(20)}T00:00:00.000Z`,
});

test("NIN is the only national identity number collected", () => {
  const sources = [
    "Models/UserModel.js",
    "Middleware/AuthValidate.js",
    "Middleware/UserValidate.js",
    "Services/AuthService.js",
    "Services/UserService.js",
    "Repositories/UserRepository.js",
    "Utilis/tierService.js",
    "Utilis/formatValidationError.js",
    "Utilis/userPayload.js",
    "Models/Policyconfigmodel.js",
    "Routes/AuthRoutes.js",
  ];

  for (const rel of sources) {
    assert.ok(!/\bbvn\b/i.test(read(rel)), `${rel} still references BVN`);
  }
});

test("NIN validation, storage, duplicate checks and tier policy stay intact", () => {
  assert.ok(
    read("Middleware/UserValidate.js").includes("nin: joi.string().pattern(/^\\d{11}$/).required()")
  );
  assert.ok(read("Models/UserModel.js").includes("nin: { type: String, default: null }"));
  assert.ok(read("Services/UserService.js").includes("{ nin }"));
  assert.ok(
    read("Repositories/UserRepository.js").includes("if (nin) identities.push({ nin: String(nin).trim() });")
  );
  assert.ok(read("Utilis/tierService.js").includes("nin: hasNIN"));
  assert.ok(read("Models/Policyconfigmodel.js").includes('requiredDocuments: ["passport", "nin"]'));
});

test("registration succeeds without BVN and strips a stray BVN key", async () => {
  const req = {
    body: {
      ...baseRegisterBody(),
      bvn: "12345678901",
    },
  };
  let nextCalled = false;

  await AuthValidator.RegisterValidate(req, {}, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(Object.hasOwn(req.body, "bvn"), false);
  assert.equal(req.body.email, "ninonly@example.com");
  assert.ok(req.body.dateOfBirth);
});

test("onboarding KYC succeeds with NIN only and strips a stray BVN key", async () => {
  const req = {
    file: { path: "uploads/kyc/nin-document.pdf" },
    body: {
      documentType: "nin",
      nin: "12345678901",
      bvn: "12345678901",
    },
  };
  let nextCalled = false;

  UserValidator.KYCUploadValidate(req, {}, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(Object.hasOwn(req.body, "bvn"), false);
  assert.deepEqual(req.body, { documentType: "nin", nin: "12345678901" });
});

test("onboarding KYC still requires NIN", () => {
  const req = {
    file: { path: "uploads/kyc/passport.pdf" },
    body: { documentType: "passport" },
  };

  assert.throws(
    () => UserValidator.KYCUploadValidate(req, {}, () => {}),
    (err) => err instanceof Error && err.statusCode === 400
  );
});

test("legacy BVN cleanup migration is dry-run by default, backed up, and unsets only bvn", () => {
  const source = read("Scripts/migrateRemoveBvnFields.js");

  assert.ok(source.includes("const DRY_RUN = !EXECUTE && !ROLLBACK_PATH"));
  assert.ok(source.includes('$unset: { [BVN_PATH]: "" }'));
  assert.ok(source.includes("timestamps: false"));
  assert.ok(source.includes("fs.writeFileSync(backupPath"));
  assert.ok(source.includes("[BVN_PATH]: { $exists: true }"));
  assert.ok(source.includes("--rollback"));
});
