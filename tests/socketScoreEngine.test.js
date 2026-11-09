const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeScore,
  validateWeightedComponents,
  calculateWeightedScore,
  calculateMonthlyScore,
  calculateCumulativeScores,
  cumulativeWeightedAverage,
  getMonthRange,
  isMonthEligibleForFinalization,
  calculateSavingDiscipline,
  calculateRepaymentConsistency,
  calculateReferralScore,
  calculateSavingsGrowth,
  calculateWithdrawalBehaviour,
  calculateProfileCompletion,
  calculateCommunityTrust,
} = require("../Services/SocketScoreEngine");

test("calculates saving discipline boundaries", () => {
  assert.equal(calculateSavingDiscipline(0, 10), 0);
  assert.equal(calculateSavingDiscipline(5, 10), 50);
  assert.equal(calculateSavingDiscipline(10, 10), 100);
  assert.equal(calculateSavingDiscipline(15, 10), 100);
});

test("calculates repayment consistency boundaries", () => {
  assert.equal(calculateRepaymentConsistency(0, 10), 0);
  assert.equal(calculateRepaymentConsistency(5, 10), 50);
  assert.equal(calculateRepaymentConsistency(10, 10), 100);
  assert.equal(calculateRepaymentConsistency(12, 10), 100);
  assert.equal(calculateRepaymentConsistency(0, 0), 0);
});

test("calculates referral score from configurable target", () => {
  assert.equal(calculateReferralScore(0, 10), 0);
  assert.equal(calculateReferralScore(5, 10), 50);
  assert.equal(calculateReferralScore(10, 10), 100);
  assert.equal(calculateReferralScore(20, 10), 100);
  assert.equal(calculateReferralScore(5, 20), 25);
  assert.equal(calculateReferralScore(5, 0), 0);
});

test("normalizes component scores to 0-100", () => {
  assert.equal(normalizeScore(-10), 0);
  assert.equal(normalizeScore(150), 100);
  assert.equal(normalizeScore("not-a-score"), 0);
});

test("calculates approved weighted score", () => {
  const result = calculateWeightedScore([
    { code: "saving", name: "Saving Discipline", rawScore: 82, weight: 35, isActive: true },
    { code: "repayment", name: "Repayment Consistency", rawScore: 95, weight: 25, isActive: true },
    { code: "referral", name: "Referral", rawScore: 60, weight: 10, isActive: true },
    { code: "other", name: "Other", rawScore: 80, weight: 30, isActive: true },
  ]);
  assert.equal(result.totalWeight, 100);
  assert.equal(result.overallScore, 82.45);
  assert.deepEqual(result.components.map((component) => component.contribution), [28.7, 23.75, 6, 24]);
});

test("rejects invalid active weight totals and duplicate codes", () => {
  assert.throws(() => validateWeightedComponents([
    { code: "saving", weight: 35, isActive: true },
    { code: "repayment", weight: 25, isActive: true },
  ]), /total exactly 100/);
  assert.throws(() => validateWeightedComponents([
    { code: "same", weight: 50, isActive: true },
    { code: "same", weight: 50, isActive: true },
  ]), /unique/);
});

test("keeps weighted totals inside 0-100", () => {
  const result = calculateWeightedScore([
    { code: "a", rawScore: -100, weight: 35, isActive: true },
    { code: "b", rawScore: 1000, weight: 25, isActive: true },
    { code: "c", rawScore: 50, weight: 10, isActive: true },
    { code: "d", rawScore: 50, weight: 30, isActive: true },
  ]);
  assert.ok(result.overallScore >= 0 && result.overallScore <= 100);
});

/* ---- CGPA-style monthly + cumulative engine ---- */

test("CGPA example: 80, 90, 70, 100 -> 80, 85, 80, 85", () => {
  const entry = (monthlyScore, month) => ({ monthlyScore, year: 2026, month, creditWeight: 1 });
  assert.deepEqual(calculateCumulativeScores([entry(80, 1), entry(90, 2), entry(70, 3), entry(100, 4)]), [80, 85, 80, 85]);
  assert.equal(cumulativeWeightedAverage([entry(80, 1), entry(90, 2)]), 85);
  assert.equal(cumulativeWeightedAverage([]), 0);
});

test("monthly engine: ineligible components are excluded and weight redistributed", () => {
  const result = calculateMonthlyScore([
    { code: "savings_consistency", name: "Savings Consistency", rawScore: 80, weight: 35, isActive: true, eligible: true },
    { code: "savings_growth", name: "Savings Growth", rawScore: null, weight: 15, isActive: true, eligible: false },
    { code: "loan_repayment", name: "Loan Repayment", rawScore: null, weight: 20, isActive: true, eligible: false },
    { code: "withdrawal_behaviour", name: "Withdrawal Behaviour", rawScore: null, weight: 10, isActive: true, eligible: false },
    { code: "profile_completion", name: "Profile Completion", rawScore: 100, weight: 5, isActive: true, eligible: true },
    { code: "community_trust", name: "Community Trust", rawScore: null, weight: 15, isActive: true, eligible: false },
  ]);
  // eligible weight = 40; score = (0.8*35 + 1*5)/40*100 = 82.5 — NOT dragged by the loan zero.
  assert.equal(result.monthlyScore, 82.5);
  assert.equal(result.eligibleWeight, 40);
});

test("spec example: 28 + 13.5 + 20 + 7 + 5 + 12 = 85.5", () => {
  const result = calculateMonthlyScore([
    { code: "savings_consistency", rawScore: 80, weight: 35, isActive: true },
    { code: "savings_growth", rawScore: 90, weight: 15, isActive: true },
    { code: "loan_repayment", rawScore: 100, weight: 20, isActive: true },
    { code: "withdrawal_behaviour", rawScore: 70, weight: 10, isActive: true },
    { code: "profile_completion", rawScore: 100, weight: 5, isActive: true },
    { code: "community_trust", rawScore: 80, weight: 15, isActive: true },
  ]);
  assert.equal(result.monthlyScore, 85.5);
});

test("savings growth: null when no balance, 100 from zero, target banding", () => {
  assert.equal(calculateSavingsGrowth(0, 0), null);
  assert.equal(calculateSavingsGrowth(0, 5000), 100);
  assert.equal(calculateSavingsGrowth(10000, 11000), 100); // +10%
  assert.equal(calculateSavingsGrowth(10000, 10500), 50); // +5%
  assert.equal(calculateSavingsGrowth(10000, 9000), 0); // declined
});

test("withdrawal behaviour: null when nothing withdrawn, full marks within 20%", () => {
  assert.equal(calculateWithdrawalBehaviour(0, 50000), null);
  assert.equal(calculateWithdrawalBehaviour(9000, 50000), 100); // 18%
  assert.equal(calculateWithdrawalBehaviour(25000, 50000), 70); // 50% -> 100-30
  assert.equal(calculateWithdrawalBehaviour(60000, 50000), 0); // 120%
  assert.equal(calculateWithdrawalBehaviour(5000, 0), 0);
});

test("profile completion: empty checklist scores 0, full checklist 100", () => {
  assert.equal(calculateProfileCompletion(0, 8), 0);
  assert.equal(calculateProfileCompletion(8, 8), 100);
  assert.equal(calculateProfileCompletion(4, 8), 50);
  assert.equal(calculateProfileCompletion(1, 0), null);
});

test("community trust: null with no verified events, scales with referrals", () => {
  assert.equal(calculateCommunityTrust(0, 0), null);
  assert.equal(calculateCommunityTrust(5, 2), 100);
  assert.equal(calculateCommunityTrust(5, 0), 70);
  assert.equal(calculateCommunityTrust(0, 2), 30);
});

test("month eligibility: current incomplete month is not finalizable", () => {
  const now = new Date(2026, 5, 15); // June 15 2026
  const created = new Date(2025, 0, 1);
  assert.equal(isMonthEligibleForFinalization({ userCreatedAt: created, year: 2026, month: 6, now }).eligible, false);
  assert.equal(isMonthEligibleForFinalization({ userCreatedAt: created, year: 2026, month: 6, now, force: true }).eligible, true);
  assert.equal(isMonthEligibleForFinalization({ userCreatedAt: created, year: 2026, month: 5, now }).eligible, true);
  // Member joined only in July 2026 -> June not eligible
  assert.equal(isMonthEligibleForFinalization({ userCreatedAt: new Date(2026, 6, 5), year: 2026, month: 6, now, force: true }).eligible, false);
});

test("getMonthRange uses exclusive end", () => {
  const { start, end } = getMonthRange(2026, 2);
  assert.deepEqual([start.getMonth(), start.getDate()], [1, 1]);
  assert.deepEqual([end.getMonth(), end.getDate()], [2, 1]);
});

test("invalid weights still rejected by monthly engine", () => {
  assert.throws(() => calculateMonthlyScore([
    { code: "a", rawScore: 50, weight: 30, isActive: true },
    { code: "b", rawScore: 50, weight: 30, isActive: true },
  ]), /total exactly 100/);
});
