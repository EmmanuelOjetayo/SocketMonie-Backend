const AppError = require("../Utilis/AppError");

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const WEIGHT_TOTAL = 100;

const DEFAULT_WEIGHTS = {
  savings_consistency: 35,
  savings_growth: 15,
  loan_repayment: 20,
  withdrawal_behaviour: 10,
  profile_completion: 5,
  community_trust: 15,
};

const round2 = (v) => Number(Number(v || 0).toFixed(2));
const clamp = (v, min = SCORE_MIN, max = SCORE_MAX) => Math.min(max, Math.max(min, Number(v) || 0));

const normalizeScore = (value) => {
  const numericScore = Number(value);
  if (!Number.isFinite(numericScore)) return SCORE_MIN;
  return clamp(numericScore);
};

const validateWeightedComponents = (components) => {
  if (!Array.isArray(components) || components.length === 0) {
    throw new AppError("At least one scoring component is required.", 400);
  }
  const activeComponents = components.filter((component) => component.isActive !== false);
  if (activeComponents.length === 0) throw new AppError("At least one scoring component must be active.", 400);
  const codes = activeComponents.map((component) => String(component.code || "").trim().toLowerCase());
  if (codes.some((code) => !code) || new Set(codes).size !== codes.length) {
    throw new AppError("Active scoring component codes must be unique and non-empty.", 400);
  }
  const totalWeight = activeComponents.reduce((total, component) => {
    const weight = Number(component.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > SCORE_MAX) {
      throw new AppError(`Invalid weight for scoring component ${component.name || component.code}.`, 400);
    }
    return total + weight;
  }, 0);
  if (Math.abs(totalWeight - WEIGHT_TOTAL) > 0.001) {
    throw new AppError(`Active scoring weights must total exactly ${WEIGHT_TOTAL}%.`, 400);
  }
  return { activeComponents, totalWeight };
};

/**
 * Original weighted calculation (preserved for backward compatibility):
 * sum of (earned / maximum) * weight over all active components where a raw
 * score exists. Components with no evidence still contribute 0 here — the
 * monthly engine below is the one that applies the eligibility rule.
 */
const calculateWeightedScore = (components) => {
  const { activeComponents, totalWeight } = validateWeightedComponents(components);
  const evaluatedComponents = activeComponents.map((component) => {
    const weight = Number(component.weight);
    const maximum = Number(component.maximum ?? component.maxPoints ?? weight);
    if (!Number.isFinite(maximum) || maximum <= 0) {
      throw new AppError(`Invalid maximum for scoring component ${component.name || component.code}.`, 400);
    }
    const hasEarnedScore = component.score !== undefined && component.score !== null;
    const earnedScore = hasEarnedScore
      ? clamp(Number(component.score) || 0, 0, maximum)
      : null;
    const rawScore = hasEarnedScore
      ? normalizeScore((earnedScore / maximum) * 100)
      : normalizeScore(component.rawScore);
    return {
      code: component.code,
      name: component.name,
      score: hasEarnedScore ? earnedScore : Number(((rawScore / 100) * weight).toFixed(2)),
      maximum,
      rawScore,
      weight,
      contribution: Number(((hasEarnedScore ? earnedScore / maximum : rawScore / 100) * weight).toFixed(2)),
      description: component.description || "",
      formulaStatus: component.formulaStatus || "assumption",
      status: component.status || component.formulaStatus || "configured",
    };
  });
  const overallScore = round2(clamp(evaluatedComponents.reduce((total, component) => total + component.contribution, 0)));
  return { overallScore, components: evaluatedComponents, totalWeight };
};

/**
 * CGPA-style MONTHLY engine.
 *
 * Each evaluated component is { code, name, rawScore (0-100 | null),
 * weight, eligible (boolean), ... }. A component is INELIGIBLE (rawScore
 * null) when there is genuinely no applicable evidence that month — e.g. no
 * loan instalments due, no withdrawals, no verified trust events. Ineligible
 * components are EXCLUDED and their weight is redistributed over the eligible
 * components instead of silently awarding 0 or 100:
 *
 *   monthlyScore = Σ(rawScore/100 × weight) over eligible
 *                  ÷ Σ(weight) over eligible × 100
 *
 * This is the eligibility/normalization rule for the whole system.
 * It keeps scores mathematically fair and transparent: explainability is
 * preserved because every stored record keeps the per-component rawScore,
 * weight and eligibility flag it was calculated with.
 */
const calculateMonthlyScore = (evaluatedComponents) => {
  const { activeComponents } = validateWeightedComponents(evaluatedComponents);
  const eligible = activeComponents.filter(
    (c) => c.eligible !== false && c.rawScore !== null && c.rawScore !== undefined && Number.isFinite(Number(c.rawScore))
  );
  const eligibleWeight = eligible.reduce((t, c) => t + Number(c.weight), 0);
  if (eligibleWeight <= 0) {
    return { monthlyScore: null, eligibleWeight: 0, contributions: [], eligible: false };
  }
  const contributions = eligible.map((c) => {
    const rawScore = normalizeScore(c.rawScore);
    return {
      code: c.code,
      name: c.name,
      rawScore,
      weight: Number(c.weight),
      contribution: round2((rawScore / 100) * Number(c.weight)),
      eligible: true,
      applicableMaximum: Number(c.applicableMaximum ?? c.maximum ?? c.weight),
    };
  });
  const monthlyScore = round2((contributions.reduce((t, c) => t + c.contribution, 0) / eligibleWeight) * 100);
  return { monthlyScore: clamp(monthlyScore), eligibleWeight, contributions, eligible: true };
};

/**
 * CGPA-style CUMULATIVe engine: cumulative weighted average over completed
 * months only. Each entry MUST be { monthlyScore, creditWeight = 1 }.
 * NEVER called with the current (incomplete) month unless that month has
 * been explicitly finalised. Returns the score AFTER each month.
 * Example: [80, 90, 70, 100] -> [80, 85, 80, 85].
 */
const calculateCumulativeScores = (monthlyEntries) => {
  const entries = [...(Array.isArray(monthlyEntries) ? monthlyEntries : [])]
    .filter((e) => e && Number.isFinite(Number(e.monthlyScore)))
    .sort((a, b) => {
      const ka = Number(a.year) * 100 + Number(a.month || 0);
      const kb = Number(b.year) * 100 + Number(b.month || 0);
      return ka - kb;
    });
  let sum = 0;
  let weightSum = 0;
  return entries.map((e) => {
    const w = Number(e.creditWeight ?? 1);
    sum += Number(e.monthlyScore) * w;
    weightSum += w;
    return round2(weightSum > 0 ? sum / weightSum : 0);
  });
};

const cumulativeWeightedAverage = (monthlyEntries) => {
  const cumulatives = calculateCumulativeScores(monthlyEntries);
  return cumulatives.length ? cumulatives[cumulatives.length - 1] : 0;
};

/** Calendar range for a month (inclusive start, exclusive end). */
const getMonthRange = (year, month) => ({
  start: new Date(year, month - 1, 1, 0, 0, 0, 0),
  end: new Date(year, month, 1, 0, 0, 0, 0),
});

/** Is the given month finalizable (user existed, month is completed)? */
const isMonthEligibleForFinalization = ({ userCreatedAt, year, month, now = new Date(), force = false } = {}) => {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m || m < 1 || m > 12 || !userCreatedAt) return { eligible: false, reason: "invalid_period" };
  if (new Date(userCreatedAt).getTime() > getMonthRange(y, m).end.getTime()) {
    return { eligible: false, reason: "member_joined_after_month" };
  }
  if (!force) {
    const curY = now.getFullYear();
    const curM = now.getMonth() + 1;
    if (y > curY || (y === curY && m >= curM)) {
      return { eligible: false, reason: "month_not_completed" };
    }
  }
  return { eligible: true, reason: "eligible" };
};

/* ---------------------------------------------------------------- */
/* Component performance calculators (all return 0-100).             */
/* ---------------------------------------------------------------- */

const calculateSavingDiscipline = (completedRequiredContributions, totalExpectedContributions) => {
  const expected = Number(totalExpectedContributions);
  const completed = Number(completedRequiredContributions);
  if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(completed) || completed <= 0) return 0;
  return normalizeScore((completed / expected) * 100);
};

const calculateRepaymentConsistency = (onTimeRepayments, totalDueRepayments) => {
  const due = Number(totalDueRepayments);
  const onTime = Number(onTimeRepayments);
  if (!Number.isFinite(due) || due <= 0 || !Number.isFinite(onTime) || onTime <= 0) return 0;
  return normalizeScore((onTime / due) * 100);
};

const calculateReferralScore = (qualifiedReferralCount, qualifiedReferralTarget) => {
  const target = Number(qualifiedReferralTarget);
  const count = Number(qualifiedReferralCount);
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(count) || count <= 0) return 0;
  return normalizeScore((count / target) * 100);
};

/**
 * Savings growth: monthly net growth relative to the opening balance.
 * targetGrowthPct = 10% monthly growth earns full marks.
 */
const calculateSavingsGrowth = (startBalance, endBalance, targetGrowthPct = 10) => {
  const start = Number(startBalance);
  const end = Number(endBalance);
  const target = Number(targetGrowthPct);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(target) || target <= 0) return null;
  if (start <= 0 && end <= 0) return null; // no savings to compare — ineligible
  if (start <= 0 && end > 0) return 100; // grew from zero
  const growthRate = ((end - start) / start) * 100;
  if (growthRate <= 0) return 0;
  return normalizeScore((growthRate / target) * 100);
};

/**
 * Withdrawal behaviour: only scored when the member actually withdrew.
 * totalWithdrawn <= 20% of the opening balance earns full marks; beyond
 * that the score falls linearly (60% of balance -> 60, 100% -> 20, 120% -> 0).
 */
const calculateWithdrawalBehaviour = (totalWithdrawn, startBalance) => {
  const withdrawn = Number(totalWithdrawn);
  const start = Number(startBalance);
  if (!Number.isFinite(withdrawn) || withdrawn <= 0) return null; // no withdrawals — ineligible
  if (!Number.isFinite(start) || start <= 0) return 0;
  const ratio = withdrawn / start;
  if (ratio <= 0.2) return 100;
  return clamp(100 - (ratio - 0.2) * 100);
};

/** Profile completion: completed checklist items / total items × 100. */
const calculateProfileCompletion = (completedItems, totalItems) => {
  const total = Number(totalItems);
  const done = Number(completedItems);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(done) || done <= 0) return 0;
  return normalizeScore((Math.min(done, total) / total) * 100);
};

/**
 * Community trust: 70% qualified referrals (target 5) + 30% verified
 * guarantor participation (target 2). If the member has no verified trust
 * events at all, the component is ineligible (null) instead of 0 so new
 * members are not penalised for a network they have not built yet.
 */
const calculateCommunityTrust = (qualifiedReferrals, guarantorCount, referralTarget = 5, guarantorTarget = 2) => {
  const refs = Number(qualifiedReferrals || 0);
  const guarantors = Number(guarantorCount || 0);
  if (refs <= 0 && guarantors <= 0) return null;
  const referralPct = normalizeScore((refs / Number(referralTarget)) * 100);
  const guarantorPct = normalizeScore((guarantors / Number(guarantorTarget)) * 100);
  return round2(0.7 * referralPct + 0.3 * guarantorPct);
};

module.exports = {
  SCORE_MIN,
  SCORE_MAX,
  WEIGHT_TOTAL,
  DEFAULT_WEIGHTS,
  round2,
  clamp,
  normalizeScore,
  validateWeightedComponents,
  calculateWeightedScore,
  calculateMonthlyScore,
  calculateCumulativeScores,
  cumulativeWeightedAverage,
  getMonthRange,
  isMonthEligibleForFinalization,
  calculateSavingDiscipline,
  calculateSavingsConsistency: calculateSavingDiscipline,
  calculateRepaymentConsistency,
  calculateReferralScore,
  calculateSavingsGrowth,
  calculateWithdrawalBehaviour,
  calculateProfileCompletion,
  calculateCommunityTrust,
};
