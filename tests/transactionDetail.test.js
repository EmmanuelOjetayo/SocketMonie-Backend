/**
 * Transaction detail lookup — unit tests.
 * Run: node Tests/transactionDetail.test.js
 *
 * `TransactionService.getOne()` backs GET /api/transactions/:id, the
 * endpoint the transaction-detail screen resolves a record from. The
 * security-critical property is OWNERSHIP: a member may only ever load
 * their own transaction, and anything else is a plain 404.
 *
 * The models are stubbed through the require cache so the suite runs
 * without a database.
 */
const assert = require("assert");
const path = require("path");

const USER_A = "64b0000000000000000000a1";
const USER_B = "64b0000000000000000000b2";

const SAVINGS_ROWS = [
  {
    _id: "64c0000000000000000000a1",
    userId: USER_A,
    type: "deposit",
    reference: "DEP_1",
    amount: 50000,
    fee: 0,
    status: "completed",
    method: "flutterwave",
    paidAt: new Date("2026-11-11T15:45:00Z"),
    metadata: {},
  },
  {
    _id: "64c0000000000000000000a2",
    userId: USER_A,
    type: "withdrawal",
    reference: "WTH_REQ_1",
    amount: 20000,
    fee: 100,
    status: "pending_approval",
    method: "flutterwave_payout",
    paidAt: new Date("2026-11-12T09:00:00Z"),
    bankDetails: {
      bankName: "GTBank",
      accountName: "Ada N",
      accountNumber: "0123456789",
    },
    metadata: {},
  },
  {
    _id: "64c0000000000000000000a3",
    userId: USER_B,
    type: "deposit",
    reference: "DEP_2",
    amount: 999999,
    status: "completed",
    metadata: {},
  },
];

const LEGACY_SAVINGS_ROWS = [
  {
    _id: "64c0000000000000000000b1",
    userId: USER_A,
    type: "deposit",
    reference: "LEGACY_1",
    amount: 7500,
    status: "completed",
    createdAt: new Date("2026-02-02T10:00:00Z"),
    metadata: {},
  },
];

const MINUTE_ROWS = [
  {
    _id: "64c0000000000000000000c1",
    userId: USER_A,
    type: "minute_contribution",
    reference: "MIN_1",
    amount: 1500,
    status: "completed",
    method: "flutterwave",
    paidAt: new Date("2026-11-01T08:00:00Z"),
    metadata: { months: ["2026-11", "2026-12"] },
  },
];

/* ------------------------------------------------------------------ */
/* Stub the models BEFORE the service is loaded                        */
/* ------------------------------------------------------------------ */

const chainable = (value) => ({
  lean: async () => value,
  select: () => chainable(value),
  then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
});

const makeModel = (rows) => ({
  find: ({ userId } = {}) =>
    chainable(rows.filter((r) => !userId || String(r.userId) === String(userId))),
  findOne: ({ _id, userId } = {}) =>
    chainable(
      rows.find(
        (r) =>
          (!_id || String(r._id) === String(_id)) &&
          (!userId || String(r.userId) === String(userId))
      ) || null
    ),
});

const stub = (modulePath, exports) => {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
};

stub("../Models/SavingsTransactionModel", makeModel(SAVINGS_ROWS));
stub("../Models/MinuteTransactionModel", makeModel(MINUTE_ROWS));
stub("../Models/MembershipTransactionModel", makeModel([]));
stub("../Models/LoanTransactionModel", makeModel([]));
stub("../Models/SavingsModel", makeModel(LEGACY_SAVINGS_ROWS));
stub("../Models/UserModel", {
  findOne: () => chainable(null),
});

const { getOne, normalize } = require("../Services/TransactionService");

let PASS = 0;
let FAIL = 0;
const failures = [];

function t(label, fn) {
  try {
    fn();
    PASS++;
    console.log(`  ✅ ${label}`);
  } catch (err) {
    FAIL++;
    console.log(`  ❌ ${label} | ${err.message}`);
    failures.push(`${label} | ${err.message}`);
  }
}

(async () => {
  console.log("\n=== GET /api/transactions/:id (ownership + resolution) ===\n");

  const deposit = await getOne(USER_A, "64c0000000000000000000a1");
  t("resolves the member's own transaction", () => {
    assert.ok(deposit, "expected a transaction");
    assert.strictEqual(deposit.label, "Savings Deposit");
    assert.strictEqual(deposit.amount, 50000);
    assert.strictEqual(deposit.direction, "credit");
    assert.strictEqual(deposit.reference, "DEP_1");
  });

  const withdrawal = await getOne(USER_A, "64c0000000000000000000a2");
  t("resolves a withdrawal with its fee and destination", () => {
    assert.ok(withdrawal);
    assert.strictEqual(withdrawal.label, "Withdrawal");
    assert.strictEqual(withdrawal.direction, "debit");
    assert.strictEqual(withdrawal.fee, 100);
    assert.strictEqual(withdrawal.status, "pending_approval");
    assert.strictEqual(withdrawal.destinationBank.bankName, "GTBank");
    assert.strictEqual(withdrawal.destinationBank.accountNumber, "0123456789");
  });

  const minute = await getOne(USER_A, "64c0000000000000000000c1");
  t("resolves a SocketMinutes contribution", () => {
    assert.ok(minute);
    assert.strictEqual(minute.label, "SocketMinutes Contribution");
    assert.strictEqual(minute.amount, 1500);
  });

  const legacy = await getOne(USER_A, "64c0000000000000000000b1");
  t("resolves a legacy record (nothing disappears from history)", () => {
    assert.ok(legacy);
    assert.strictEqual(legacy.amount, 7500);
    assert.strictEqual(legacy.reference, "LEGACY_1");
  });

  const foreign = await getOne(USER_B, "64c0000000000000000000a1");
  t("another member's transaction is NOT resolvable (404 path)", () => {
    assert.strictEqual(foreign, null);
  });

  const missing = await getOne(USER_A, "64c0000000000000000000d1");
  t("an unknown id resolves to null", () => {
    assert.strictEqual(missing, null);
  });

  const malformed = await getOne(USER_A, "not-an-object-id");
  t("a malformed id resolves to null (no crash)", () => {
    assert.strictEqual(malformed, null);
  });

  const noUser = await getOne(null, "64c0000000000000000000a1");
  t("a missing user resolves to null", () => {
    assert.strictEqual(noUser, null);
  });

  t("normalize exposes the fields a receipt needs", () => {
    const row = normalize("savings", {
      _id: "x",
      type: "withdrawal",
      amount: 5000,
      fee: 100,
      status: "completed",
      reference: "WTH_9",
    });
    assert.strictEqual(row.fee, 100);
    assert.strictEqual(row.direction, "debit");
    assert.strictEqual(row.label, "Withdrawal");
    assert.ok("date" in row);
    assert.ok("method" in row);
    assert.ok("transactionId" in row);
  });

  console.log(`\nTransaction detail tests: ${PASS} passed, ${FAIL} failed, ${PASS + FAIL} total`);
  if (FAIL > 0) {
    console.error("\nFailures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
})();
