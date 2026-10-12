const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeScore,
  validateWeightedComponents,
  calculateWeightedScore,
  calculateSavingDiscipline,
  calculateRepaymentConsistency,
  calculateReferralScore,
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
