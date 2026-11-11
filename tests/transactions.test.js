/**
 * Transaction model separation — unit tests.
 * Run: node Tests/transactions.test.js
 *
 * Covers:
 *  - The four dedicated transaction models compile with the expected fields
 *  - buildDateRange month/year math
 *  - normalize() label/direction mapping for every transaction type
 *  - dedupeTransactions() reference de-duplication (new model wins)
 */
const assert = require("assert");

const SavingsTransaction = require("../Models/SavingsTransactionModel");
const MinuteTransaction = require("../Models/MinuteTransactionModel");
const MembershipTransaction = require("../Models/MembershipTransactionModel");
const LoanTransaction = require("../Models/LoanTransactionModel");

const {
  buildDateRange,
  normalize,
  dedupeTransactions,
  matchesSearch,
} = require("../Services/TransactionService");

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

console.log("\n=== Transaction Models ===\n");

t("SavingsTransaction model exposes required paths", () => {
  const paths = SavingsTransaction.schema.paths;
  ["userId", "type", "reference", "transactionId", "amount", "status", "paidAt"].forEach((p) =>
    assert.ok(paths[p], `missing path ${p}`)
  );
});

t("MinuteTransaction model exposes required paths", () => {
  const paths = MinuteTransaction.schema.paths;
  ["userId", "type", "reference", "transactionId", "amount", "status", "paidAt", "metadata"].forEach((p) =>
    assert.ok(paths[p], `missing path ${p}`)
  );
});

t("MembershipTransaction model exposes required paths", () => {
  const paths = MembershipTransaction.schema.paths;
  ["userId", "type", "reference", "transactionId", "amount", "status", "paidAt"].forEach((p) =>
    assert.ok(paths[p], `missing path ${p}`)
  );
});

t("LoanTransaction model exposes required paths", () => {
  const paths = LoanTransaction.schema.paths;
  ["userId", "loanId", "type", "reference", "transactionId", "amount", "status", "paidAt"].forEach((p) =>
    assert.ok(paths[p], `missing path ${p}`)
  );
});

t("references are unique + sparse across all four models", () => {
  [SavingsTransaction, MinuteTransaction, MembershipTransaction, LoanTransaction].forEach((M) => {
    const ref = M.schema.paths.reference;
    assert.strictEqual(ref.options.unique, true, `${M.modelName}.reference not unique`);
    assert.strictEqual(ref.options.sparse, true, `${M.modelName}.reference not sparse`);
  });
});

console.log("\n=== buildDateRange ===\n");

t("month + year produces [monthStart, nextMonthStart)", () => {
  const r = buildDateRange("3", "2026");
  assert.deepStrictEqual(r.start, new Date(2026, 2, 1));
  assert.deepStrictEqual(r.end, new Date(2026, 3, 1));
});

t("year only produces the full calendar year", () => {
  const r = buildDateRange("", "2026");
  assert.deepStrictEqual(r.start, new Date(2026, 0, 1));
  assert.deepStrictEqual(r.end, new Date(2027, 0, 1));
});

t("no month/year returns null", () => {
  assert.strictEqual(buildDateRange("", ""), null);
  assert.strictEqual(buildDateRange(null, null), null);
});

console.log("\n=== normalize ===\n");

t("savings deposit → credit, 'Savings Deposit'", () => {
  const tx = normalize("savings", { _id: "a", type: "deposit", amount: 25000, status: "completed", reference: "DEP-1" });
  assert.strictEqual(tx.label, "Savings Deposit");
  assert.strictEqual(tx.direction, "credit");
  assert.strictEqual(tx.amount, 25000);
});

t("savings withdrawal → debit, 'Withdrawal'", () => {
  const tx = normalize("savings", { _id: "b", type: "withdrawal", amount: 5000, status: "completed", reference: "WTH-1" });
  assert.strictEqual(tx.label, "Withdrawal");
  assert.strictEqual(tx.direction, "debit");
});

t("minute contribution → 'SocketMinutes Contribution'", () => {
  const tx = normalize("minute", { _id: "c", type: "minute_contribution", amount: 500, status: "completed", reference: "MIN_1" });
  assert.strictEqual(tx.label, "SocketMinutes Contribution");
  assert.strictEqual(tx.direction, "credit");
});

t("membership fee → 'Membership Fee'", () => {
  const tx = normalize("membership", { _id: "d", type: "membership_fee", amount: 1000, status: "completed", reference: "MEM-1" });
  assert.strictEqual(tx.label, "Membership Fee");
});

t("loan repayment → 'Loan Repayment'", () => {
  const tx = normalize("loan", { _id: "e", type: "loan_repayment", amount: 18700, status: "completed", reference: "LRP-1" });
  assert.strictEqual(tx.label, "Loan Repayment");
});

t("loan disbursement → 'Loan Disbursement'", () => {
  const tx = normalize("loan", { _id: "f", type: "loan_disbursement", amount: 98000, status: "completed", reference: "LNP-1" });
  assert.strictEqual(tx.label, "Loan Disbursement");
});

t("falls back to a generic label for unknown categories", () => {
  const tx = normalize("savings", { _id: "g", type: "mystery", amount: 1, status: "completed" });
  assert.strictEqual(tx.label, "Savings");
});

console.log("\n=== dedupeTransactions ===\n");

t("removes legacy twins with the same reference (first wins)", () => {
  const merged = [
    { id: "new", type: "savings", reference: "DEP-1", amount: 100 },
    { id: "legacy", type: "savings", reference: "DEP-1", amount: 100 },
    { id: "other", type: "savings", reference: "DEP-2", amount: 200 },
  ];
  const out = dedupeTransactions(merged);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, "new");
});

t("keeps rows that have no reference (keyed by type:id)", () => {
  const merged = [
    { id: "x", type: "minute", reference: null, amount: 500 },
    { id: "y", type: "minute", reference: null, amount: 500 },
  ];
  const out = dedupeTransactions(merged);
  assert.strictEqual(out.length, 2);
});

console.log("\n=== fee + search ===\n");

t("normalize exposes the stored fee (withdrawal receipts need it)", () => {
  const tx = normalize("savings", {
    _id: "h",
    type: "withdrawal",
    amount: 5000,
    fee: 100,
    status: "completed",
    reference: "WTH-2",
  });
  assert.strictEqual(tx.fee, 100);
});

t("normalize defaults fee to 0 when the record has none", () => {
  const tx = normalize("savings", { _id: "i", type: "deposit", amount: 100, status: "completed" });
  assert.strictEqual(tx.fee, 0);
});

t("matchesSearch finds a row by reference (case-insensitive)", () => {
  const row = { label: "Savings Deposit", reference: "DEP-9Z", transactionId: null };
  assert.strictEqual(matchesSearch(row, "dep-9z"), true);
  assert.strictEqual(matchesSearch(row, "DEP-9Z"), true);
});

t("matchesSearch finds a row by label", () => {
  const row = { label: "SocketMinutes Contribution", reference: "MIN-1", transactionId: null };
  assert.strictEqual(matchesSearch(row, "socketminutes"), true);
});

t("matchesSearch finds a row by provider transaction id", () => {
  const row = { label: "Loan Repayment", reference: "LRP-1", transactionId: "FLW-998877" };
  assert.strictEqual(matchesSearch(row, "flw-9988"), true);
});

t("matchesSearch rejects a non-matching query", () => {
  const row = { label: "Savings Deposit", reference: "DEP-1", transactionId: null };
  assert.strictEqual(matchesSearch(row, "loan"), false);
});

t("matchesSearch treats an empty query as match-all", () => {
  const row = { label: "Savings Deposit", reference: "DEP-1", transactionId: null };
  assert.strictEqual(matchesSearch(row, ""), true);
  assert.strictEqual(matchesSearch(row, "   "), true);
  assert.strictEqual(matchesSearch(row, null), true);
});

console.log(`\nTransactions tests: ${PASS} passed, ${FAIL} failed, ${PASS + FAIL} total`);
if (FAIL > 0) {
  console.error("\nFailures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
