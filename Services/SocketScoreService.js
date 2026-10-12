const { ScoreRepository } = require("../Repositories/ScoreRepository");
const AppError = require("../Utilis/AppError");
const {
  calculateWeightedScore,
  normalizeScore,
  validateWeightedComponents,
  calculateSavingDiscipline,
  calculateRepaymentConsistency,
  calculateReferralScore,
} = require("./SocketScoreEngine");

/**
 * 1. Savings Discipline Component (0 - 100)
 */
const evaluateSavingsDiscipline = async (userId, user) => {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const deposits = await ScoreRepository.findUserDepositsSince(userId, sixMonthsAgo);
  const monthlyCommitment = Number(user.monthlySavingsCommitment);
  if (!Number.isFinite(monthlyCommitment) || monthlyCommitment <= 0 || !user.createdAt) {
    return { score: 0, status: "insufficient_data" };
  }

  const startDate = new Date(Math.max(sixMonthsAgo.getTime(), new Date(user.createdAt).getTime()));
  const now = new Date();
  const expectedMonths = (now.getFullYear() - startDate.getFullYear()) * 12
    + now.getMonth() - startDate.getMonth() + 1;
  const totalExpectedContributions = Math.max(0, expectedMonths) * monthlyCommitment;
  const completedRequiredContributions = deposits.reduce((sum, deposit) => sum + Number(deposit.amount || 0), 0);
  if (totalExpectedContributions <= 0) return { score: 0, status: "insufficient_data" };
  return {
    score: calculateSavingDiscipline(completedRequiredContributions, totalExpectedContributions),
    status: "configured",
  };
};

/**
 * 2. Loan Repayment Consistency Component (0 - 100)
 */
const evaluateRepaymentConsistency = async (userId) => {
  const loans = await ScoreRepository.findUserLoans(userId);
  let totalDueRepayments = 0;
  let onTimeRepayments = 0;
  const now = new Date();

  loans.forEach((loan) => {
    (loan.installments || []).forEach((inst) => {
      if (!inst.dueDate || new Date(inst.dueDate) > now) return;
      totalDueRepayments += 1;
      if (inst.status === "paid" && inst.paidAt && new Date(inst.paidAt) <= new Date(inst.dueDate)) {
        onTimeRepayments += 1;
      }
    });
  });
  if (totalDueRepayments === 0) return { score: 0, status: "insufficient_data" };
  return { score: calculateRepaymentConsistency(onTimeRepayments, totalDueRepayments), status: "configured" };
};

/**
 * 3. Referral Activity Component (0 - 100)
 * Target: 5 qualified referrals = 100/100 (20 points per qualified referral)
 */
const evaluateReferralActivity = async (userId, component) => {
  const target = Number(component.normalizationConfig?.qualifiedReferralTarget);
  if (!Number.isFinite(target) || target <= 0) return { score: 0, status: "unconfigured" };
  const qualifiedCount = await ScoreRepository.countQualifiedReferrals(userId);
  return { score: calculateReferralScore(qualifiedCount, target), status: "configured" };
};

const evaluateOther = (component) => {
  const configuredScore = component.normalizationConfig?.otherScore;
  if (!Number.isFinite(Number(configuredScore))) return { score: 0, status: "unconfigured" };
  return { score: normalizeScore(configuredScore), status: "configured" };
};

/**
 * Calculate complete, explainable SocketScore
 */
const calculateScore = async (userId) => {
  const user = await ScoreRepository.findUser(userId);
  if (!user) throw new AppError("User not found", 404);

  const config = await ScoreRepository.findActiveConfig();
  const activeComponents = config.components.filter((c) => c.isActive !== false);

  const evaluatedComponents = [];
  let weightedTotal = 0;

  for (const comp of activeComponents) {
    let evaluation;

    switch (comp.calculationRule) {
      case "savings_consistency_6m":
        evaluation = await evaluateSavingsDiscipline(userId, user);
        break;
      case "loan_repayment_timeliness":
        evaluation = await evaluateRepaymentConsistency(userId);
        break;
      case "referral_activity":
        evaluation = await evaluateReferralActivity(userId, comp);
        break;
      case "other_configured":
        evaluation = evaluateOther(comp);
        break;
      case "account_activity":
      case "profile_kyc_completion":
      default:
        evaluation = { score: 0, status: "unconfigured" };
        break;
    }

    evaluatedComponents.push({
      code: comp.code,
      name: comp.name,
      rawScore: normalizeScore(evaluation.score),
      weight: comp.weight,
      formulaStatus: comp.formulaStatus,
      status: evaluation.status,
      description: comp.description,
    });
  }

  const weightedResult = calculateWeightedScore(evaluatedComponents);

  return {
    userId,
    overallScore: weightedResult.overallScore,
    components: weightedResult.components,
    configurationVersion: config.version,
    calculatedAt: new Date(),
  };
};

/**
 * Recalculate, persist score, and record history entry
 */
const updateUserScore = async (userId, trigger = "system_update") => {
  const result = await calculateScore(userId);

  const breakdownObj = {};
  result.components.forEach((c) => {
    breakdownObj[c.code] = c.rawScore;
  });

  await ScoreRepository.updateUserScore(userId, result.overallScore, breakdownObj);

  const now = new Date();
  await ScoreRepository.createScoreHistory({
    userId,
    overallScore: result.overallScore,
    breakdown: breakdownObj,
    components: result.components.map((component) => ({
      code: component.code,
      name: component.name,
      score: component.score,
      maximum: component.maximum,
      rawScore: component.rawScore,
      weight: component.weight,
      contribution: component.contribution,
      status: component.status,
    })),
    configurationVersion: result.configurationVersion,
    calculatedAt: result.calculatedAt,
    period: { year: now.getFullYear(), month: now.getMonth() + 1 },
    trigger,
  });

  return result;
};

/**
 * Admin Configuration Management
 */
const updateScoringConfig = async (components, changeNotes, adminUserId) => {
  validateWeightedComponents(components);

  return await ScoreRepository.createConfigVersion(components, changeNotes, adminUserId);
};

const SocketScoreService = {
  calculateScore,
  updateUserScore,
  getActiveConfig: () => ScoreRepository.findActiveConfig(),
  getAllConfigs: () => ScoreRepository.getAllConfigs(),
  updateScoringConfig,
  getScoreHistory: (userId, limit) => ScoreRepository.findScoreHistory(userId, limit),
  normalizeScore,
  calculateWeightedScore,
};

module.exports = { SocketScoreService };
