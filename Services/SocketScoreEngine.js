const AppError = require("../Utilis/AppError");

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const WEIGHT_TOTAL = 100;

const normalizeScore = (value) => {
  const numericScore = Number(value);
  if (!Number.isFinite(numericScore)) return SCORE_MIN;
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, numericScore));
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
      ? Math.min(maximum, Math.max(0, Number(component.score) || 0))
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
  const overallScore = Number(
    Math.min(SCORE_MAX, Math.max(SCORE_MIN, evaluatedComponents.reduce((total, component) => total + component.contribution, 0))).toFixed(2)
  );
  return { overallScore, components: evaluatedComponents, totalWeight };
};

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

module.exports = {
  SCORE_MIN,
  SCORE_MAX,
  WEIGHT_TOTAL,
  normalizeScore,
  validateWeightedComponents,
  calculateWeightedScore,
  calculateSavingDiscipline,
  calculateRepaymentConsistency,
  calculateReferralScore,
};