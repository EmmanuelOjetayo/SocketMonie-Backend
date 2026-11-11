const test = require("node:test");
const assert = require("node:assert/strict");
const {
  toCanonicalStatus,
  typeFromReference,
  isReconcilableReference,
} = require("../Utilis/paymentStatus");

test("toCanonicalStatus maps settled statuses to successful", () => {
  assert.equal(toCanonicalStatus("completed"), "successful");
  assert.equal(toCanonicalStatus("successful"), "successful");
  assert.equal(toCanonicalStatus("success"), "successful");
  assert.equal(toCanonicalStatus("approved"), "successful");
  assert.equal(toCanonicalStatus("paid"), "successful");
});

test("toCanonicalStatus maps unsettled statuses to pending", () => {
  assert.equal(toCanonicalStatus("pending"), "pending");
  assert.equal(toCanonicalStatus("pending_approval"), "pending");
  assert.equal(toCanonicalStatus("processing"), "pending");
});

test("toCanonicalStatus maps failed statuses to failed", () => {
  assert.equal(toCanonicalStatus("failed"), "failed");
  assert.equal(toCanonicalStatus("rejected"), "failed");
  assert.equal(toCanonicalStatus("cancelled"), "failed");
  assert.equal(toCanonicalStatus("terminated"), "failed");
  assert.equal(toCanonicalStatus("reversed"), "failed");
});

test("toCanonicalStatus never invents success for unknown values", () => {
  // Defense: an unknown/unexpected status must default to pending -- the
  // success page only shows green on an explicitly-confirmed "successful".
  assert.equal(toCanonicalStatus("weird_provider_state"), "pending");
  assert.equal(toCanonicalStatus(undefined), "pending");
  assert.equal(toCanonicalStatus(""), "pending");
});

test("typeFromReference detects every server-generated prefix", () => {
  assert.equal(typeFromReference("DEP_123_abc"), "deposit");
  assert.equal(typeFromReference("WTH_123_abc"), "withdrawal");
  assert.equal(typeFromReference("MIN_123_abc"), "minute_contribution");
  assert.equal(typeFromReference("MEM_123_abc"), "membership_fee");
  assert.equal(typeFromReference("LRP_123_abc"), "loan_repayment");
  assert.equal(typeFromReference("RPL_123_abc"), "loan_repayment");
  assert.equal(typeFromReference("LRP-123-abc"), "loan_repayment");
});

test("typeFromReference returns null for foreign references", () => {
  assert.equal(typeFromReference("FLW_12345"), null);
  assert.equal(typeFromReference(""), null);
  assert.equal(typeFromReference(null), null);
});

test("isReconcilableReference only allows known server-generated prefixes", () => {
  assert.equal(isReconcilableReference("DEP_123_abc"), true);
  assert.equal(isReconcilableReference("MIN_123_abc"), true);
  assert.equal(isReconcilableReference("MEM_123_abc"), true);
  assert.equal(isReconcilableReference("LRP_123_abc"), true);
  assert.equal(isReconcilableReference("RPL_123_abc"), true);
  assert.equal(isReconcilableReference("LRP-123-abc"), true);
  assert.equal(isReconcilableReference("WTH_123_abc"), false);
  assert.equal(isReconcilableReference("FLW_12345"), false);
});
