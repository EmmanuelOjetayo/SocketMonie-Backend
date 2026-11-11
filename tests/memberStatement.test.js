const test = require("node:test");
const assert = require("node:assert/strict");
const {
  monthRange,
  sumCompleted,
  calculateGrowthRate,
  pickScore,
} = require("../Services/MemberStatementService");

/* ------------------------------------------------------------------ */
/* monthRange — UTC boundaries incl. rollover + leap years             */
/* ------------------------------------------------------------------ */

test("monthRange: normal month boundaries are UTC-correct", () => {
  const r = monthRange(2026, 7);
  assert.equal(r.start.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(r.end.toISOString(), "2026-07-31T23:59:59.999Z");
});

test("monthRange: January rolls previous month back to December of prior year", () => {
  const r = monthRange(2026, 1);
  assert.equal(r.prevMonth, 12);
  assert.equal(r.prevYear, 2025);
  assert.equal(r.prevStart.toISOString(), "2025-12-01T00:00:00.000Z");
  assert.equal(r.prevEnd.toISOString(), "2025-12-31T23:59:59.999Z");
});

test("monthRange: leap-year February ends on the 29th", () => {
  const r = monthRange(2024, 2);
  assert.equal(r.end.toISOString(), "2024-02-29T23:59:59.999Z");
});

test("monthRange: rejects invalid input", () => {
  assert.equal(monthRange(2026, 13), null);
  assert.equal(monthRange(2026, 0), null);
  assert.equal(monthRange("x", 5), null);
  assert.equal(monthRange(2026, null), null);
});

/* ------------------------------------------------------------------ */
/* sumCompleted — pending/failed money never enters totals             */
/* ------------------------------------------------------------------ */

test("sumCompleted: only completed records count toward money totals", () => {
  const records = [
    { amount: 5000, status: "completed" },
    { amount: 3000, status: "pending" },
    { amount: 2000, status: "failed" },
    { amount: 1000, status: "pending_approval" },
    { amount: 500, status: "completed" },
  ];
  assert.equal(sumCompleted(records), 5500);
});

test("sumCompleted: empty and missing amounts are safe", () => {
  assert.equal(sumCompleted([]), 0);
  assert.equal(sumCompleted([{ amount: null, status: "completed" }]), 0);
});

/* ------------------------------------------------------------------ */
/* calculateGrowthRate — long-standing edge rules preserved            */
/* ------------------------------------------------------------------ */

test("calculateGrowthRate: previous 0 with current > 0 grades to 100", () => {
  assert.equal(calculateGrowthRate(5000, 0), 100);
});

test("calculateGrowthRate: nothing saved either month grades to 0", () => {
  assert.equal(calculateGrowthRate(0, 0), 0);
});

test("calculateGrowthRate: percentage change, incl. negative", () => {
  assert.equal(calculateGrowthRate(15000, 10000), 50);
  assert.equal(calculateGrowthRate(5000, 10000), -50);
});

/* ------------------------------------------------------------------ */
/* pickScore — never fabricates a score                                */
/* ------------------------------------------------------------------ */

test("pickScore: monthlyScore wins over legacy mirror", () => {
  assert.equal(
    pickScore({ monthlyScore: 88, overallScore: 50, cumulativeScore: 60 }),
    88
  );
});

test("pickScore: falls back to legacy overallScore then cumulative", () => {
  assert.equal(pickScore({ overallScore: 72, cumulativeScore: 40 }), 72);
  assert.equal(pickScore({ cumulativeScore: 65 }), 65);
});

test("pickScore: missing row or all-null fields yield null", () => {
  assert.equal(pickScore(null), null);
  assert.equal(pickScore({}), null);
  assert.equal(pickScore({ monthlyScore: null }), null);
});
