/**
 * Test-only fixture seeding for the SocketMonnie system integration suite.
 *
 * The suite (tests/system.test.js) authenticates as exactly one member
 * account: authtest@test.com / TestPass123!. Rather than hand-crafting the
 * account inside the HTTP suite, this helper writes it directly to the
 * database the running test server uses, so the fixture is deterministic and
 * independent of e-mail/OTP delivery (no external services are involved).
 *
 * SAFETY RULES (deliberate, please do not relax):
 *   1. It refuses to write to a REMOTE cluster unless SEED_ALLOW_REMOTE=1 is
 *      explicitly set. A test fixture must never land in a production
 *      database — this guard is what makes that impossible by accident.
 *   2. It only ever writes the single documented fixture account.
 *   3. It never invents business data: the account is an ordinary verified
 *      member with the same field values the registration flow produces
 *      (verified email, completed status, consent recorded, referral code).
 */
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const FIXTURE_USER = {
  fullName: "Auth Test User",
  email: "authtest@test.com",
  phone: "08012345678",
  password: "TestPass123!",
  role: "member",
  referralCode: "AUTHTEST01",
};

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];

const resolveMongoUrl = () =>
  process.env.MONGO_URL ||
  process.env.MONGODB_URI ||
  "mongodb://127.0.0.1:27017/socketmonnie_test";

const assertWritableTarget = (uri) => {
  const isLocal = LOCAL_HOSTS.some((h) => uri.includes(h));
  if (!isLocal && process.env.SEED_ALLOW_REMOTE !== "1") {
    throw new Error(
      "[seedTestData] Refusing to seed a remote MongoDB cluster. " +
        "Point MONGO_URL at a local test database, or set SEED_ALLOW_REMOTE=1 explicitly."
    );
  }
  return uri;
};

/**
 * Creates (or refreshes) the member fixture used by the integration suite.
 * Returns the persisted document.
 */
const seedTestUser = async () => {
  const uri = assertWritableTarget(resolveMongoUrl());

  // The User model owns the schema; require it through the app's own model
  // path so the fixture can never drift from the real schema.
  const User = require("../../Models/UserModel");

  const hashedPassword = await bcrypt.hash(FIXTURE_USER.password, 10);

  const doc = await User.findOneAndUpdate(
    { email: FIXTURE_USER.email },
    {
      $set: {
        fullName: FIXTURE_USER.fullName,
        phone: FIXTURE_USER.phone,
        password: hashedPassword,
        role: FIXTURE_USER.role,
        referralCode: FIXTURE_USER.referralCode,
        // A verified, active member — exactly what the auth flow expects.
        isVerified: true,
        status: "completed",
        membershipFeePaid: true,
        membershipFeePaidAt: new Date(),
        termsAccepted: true,
        privacyAccepted: true,
        termsAcceptedAt: new Date(),
        privacyAcceptedAt: new Date(),
      },
      $unset: { otp: 1, otpExpiresAt: 1, resetPasswordOTP: 1, resetPasswordOTPExpiresAt: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return doc;
};

/**
 * Seeds the fixture then closes the connection again (the suite talks to the
 * running server over HTTP, it does not need a live DB handle).
 */
const seedTestUserAndClose = async () => {
  try {
    const uri = resolveMongoUrl();
    assertWritableTarget(uri);
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    }
    const doc = await seedTestUser();
    return doc;
  } finally {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
  }
};

module.exports = { seedTestUser, seedTestUserAndClose, FIXTURE_USER };
