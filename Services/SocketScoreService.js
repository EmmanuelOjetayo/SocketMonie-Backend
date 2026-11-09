const { ScoreRepository } = require("../Repositories/ScoreRepository");
const AppError = require("../Utilis/AppError");
const { getMinCommitmentForTier } = require("../Utilis/tierService");
const {
  normalizeScore,
  validateWeightedComponents,
  getMonthRange,
  isMonthEligibleForFinalization,
  calculateSavingDiscipline,
  calculateRepaymentConsistency,
  calculateSavingsGrowth,
  calculateWithdrawalBehaviour,
  calculateProfileCompletion,
  calculateCommunityTrust,
  calculateMonthlyScore,
  calculateCumulativeScores,
  cumulativeWeightedAverage,
} = require("./SocketScoreEngine");

/**
 * SocketMinutes shares 20% of the savings allocation: minutes payments
 * count toward Savings Consistency at 20% of their face value (they are
 * fixed ₦500 contributions, not full savings deposits). Regular savings
 * count at 100% — so minutes help, but can never fully substitute for
 * savings commitment; the maximum consistency minutes alone can give a
 * member is 20% of the consistency component.
 */
const MINUTES_SAVINGS_SHARE = 0.20;

const COMPONENT_DESCRIPTIONS = {
  savings_consistency: "Verified savings deposits this month / monthly savings commitment (tier minimum fallback). SocketMinutes payments count at 20% of their value toward this component.",
  savings_growth: "Monthly net savings growth vs opening balance; 10% monthly growth earns full marks.",
  loan_repayment: "Share of instalments due this month that were paid on time.",
  withdrawal_behaviour: "Withdrawals relative to opening balance; up to 20% earns full marks.",
  profile_completion: "Verified personal info, verified bank details and approved KYC.",
  community_trust: "Qualified referrals (70% weight, target 5) + verified guarantor participation (30%, target 2).",
};

const evaluateSavingsConsistency = async (userId, user, start, end) => {
  const deposits = await ScoreRepository.findUserDepositsInRange(userId, start, end);
  const monthlyCommitment = Number(user.monthlySavingsCommitment);
  const fallbackCommitment = Number((await getMinCommitmentForTier(user.tier || user.currentTier || "Bronze")) || 0);
  const expectedCommitment =
    Number.isFinite(monthlyCommitment) && monthlyCommitment > 0 ? monthlyCommitment : fallbackCommitment;
  if (!Number.isFinite(expectedCommitment) || expectedCommitment <= 0 || !user.createdAt) {
    return { rawScore: null, status: "ineligible", note: "no expected savings commitment" };
  }
  // Minutes deposits (category "minutes_payment") count toward savings
  // consistency at MINUTES_SAVINGS_SHARE (20%) of face value; regular
  // savings deposits count at face value.
  let regularDeposited = 0;
  let minutesDeposited = 0;
  deposits.forEach((d) => {
    const amount = Number(d.amount || 0);
    if (d.category === "minutes_payment") minutesDeposited += amount;
    else regularDeposited += amount;
  });
  const totalDeposited = regularDeposited + minutesDeposited;
  const weightedDeposited = regularDeposited + minutesDeposited * MINUTES_SAVINGS_SHARE;
  const sourceRefs = deposits.map((d) => d.reference || String(d._id)).filter(Boolean);
  if (weightedDeposited <= 0) {
    return { rawScore: 0, status: "configured", sourceRefs, totalDeposited, expectedCommitment, minutesDeposited, weightedDeposited };
  }
  return {
    rawScore: calculateSavingDiscipline(weightedDeposited, expectedCommitment),
    status: "configured",
    sourceRefs,
    totalDeposited,
    minutesDeposited,
    weightedDeposited,
    expectedCommitment,
  };
};

const evaluateSavingsGrowth = async (userId, start, end) => {
  const startBalance = await ScoreRepository.findNetBalanceBefore(userId, start);
  const deposits = await ScoreRepository.findUserDepositsInRange(userId, start, end);
  const withdrawals = await ScoreRepository.findUserWithdrawalsInRange(userId, start, end);
  const monthNet = deposits.reduce((s, d) => s + Number(d.amount || 0), 0) - withdrawals.reduce((s, d) => s + Number(d.amount || 0), 0);
  const endBalance = startBalance + monthNet;
  const score = calculateSavingsGrowth(startBalance, endBalance, 10);
  const sourceRefs = [...deposits, ...withdrawals].map((d) => d.reference || String(d._id)).filter(Boolean);
  if (score === null) return { rawScore: null, status: "ineligible", note: "no measurable savings balance", startBalance, endBalance, sourceRefs };
  return { rawScore: score, status: "configured", startBalance, endBalance, sourceRefs };
};

const evaluateLoanRepayment = async (userId, start, end) => {
  const loans = await ScoreRepository.findUserLoans(userId);
  let totalDue = 0;
  let onTime = 0;
  const sourceRefs = new Set();
  loans.forEach((loan) => {
    (loan.installments || []).forEach((inst) => {
      const due = new Date(inst.dueDate);
      if (due < start || due >= end) return;
      totalDue += 1;
      if (inst.status === "paid" && inst.paidAt && new Date(inst.paidAt) <= due) onTime += 1;
    });
    (loan.repaymentHistory || []).forEach((r) => r.reference && sourceRefs.add(r.reference));
  });
  if (totalDue === 0) return { rawScore: null, status: "ineligible", note: "no loan instalments due this month", totalDue, onTime };
  return { rawScore: calculateRepaymentConsistency(onTime, totalDue), status: "configured", totalDue, onTime, sourceRefs: [...sourceRefs] };
};

const evaluateWithdrawalBehaviour = async (userId, start, end) => {
  const withdrawals = await ScoreRepository.findUserWithdrawalsInRange(userId, start, end);
  const totalWithdrawn = withdrawals.reduce((s, w) => s + Number(w.amount || 0), 0);
  const startBalance = await ScoreRepository.findNetBalanceBefore(userId, start);
  const score = calculateWithdrawalBehaviour(totalWithdrawn, startBalance);
  const sourceRefs = withdrawals.map((w) => w.reference || String(w._id)).filter(Boolean);
  if (score === null) return { rawScore: null, status: "ineligible", note: "no withdrawals this month", totalWithdrawn, startBalance };
  return { rawScore: score, status: "configured", totalWithdrawn, startBalance, sourceRefs };
};

const evaluateProfileCompletion = (user) => {
  const checklist = [
    Boolean(user.dateOfBirth),
    Boolean(user.gender),
    Boolean(user.address),
    Boolean(user.stateOfOrigin),
    Boolean(user.occupation),
    Number(user.monthlySavingsCommitment || 0) > 0,
    user.bankDetails?.verified === true,
    user.kycStatus === "approved" && Boolean(user.documentUrl),
  ];
  const completed = checklist.filter(Boolean).length;
  return { rawScore: calculateProfileCompletion(completed, checklist.length), status: "configured", completedItems: completed, totalItems: checklist.length, sourceRefs: user.documentUrl ? [user.documentUrl] : [] };
};

const evaluateCommunityTrust = async (userId, end) => {
  const qualified = await ScoreRepository.countQualifiedReferralsUpTo(userId, end);
  const guarantorCount = await ScoreRepository.countGuarantorParticipations(userId);
  const score = calculateCommunityTrust(qualified, guarantorCount, 5, 2);
  if (score === null) return { rawScore: null, status: "ineligible", note: "no verified referrals or guarantor participation yet", qualified, guarantorCount };
  return { rawScore: score, status: "configured", qualifiedReferrals: qualified, guarantorCount, sourceRefs: [] };
};

const calculateScoreForPeriod = async (userId, { year, month } = {}) => {
  const now = new Date();
  const y = Number(year) || now.getFullYear();
  const m = Number(month) || now.getMonth() + 1;
  const { start, end } = getMonthRange(y, m);
  const user = await ScoreRepository.findUser(userId);
  if (!user) throw new AppError("User not found", 404);
  const config = await ScoreRepository.findActiveConfig();
  const activeComponents = config.components.filter((c) => c.isActive !== false);
  const evaluatedComponents = [];
  const sourceRefs = new Set();
  for (const comp of activeComponents) {
    let evaluation;
    switch (comp.calculationRule) {
      case "savings_consistency_6m": evaluation = await evaluateSavingsConsistency(userId, user, start, end); break;
      case "savings_growth": evaluation = await evaluateSavingsGrowth(userId, start, end); break;
      case "loan_repayment_timeliness": evaluation = await evaluateLoanRepayment(userId, start, end); break;
      case "withdrawal_behaviour": evaluation = await evaluateWithdrawalBehaviour(userId, start, end); break;
      case "profile_completion": case "profile_kyc_completion": evaluation = evaluateProfileCompletion(user); break;
      case "community_trust": case "referral_activity": evaluation = await evaluateCommunityTrust(userId, end); break;
      case "other_configured": {
        const v = comp.normalizationConfig?.otherScore;
        evaluation = Number.isFinite(Number(v)) ? { rawScore: normalizeScore(v), status: "configured", sourceRefs: [] } : { rawScore: null, status: "ineligible", note: "no configured score" };
        break;
      }
      default: evaluation = { rawScore: null, status: "ineligible", note: "no implemented formula for this rule" }; break;
    }
    (evaluation.sourceRefs || []).forEach((r) => r && sourceRefs.add(String(r)));
    evaluatedComponents.push({
      code: comp.code,
      name: comp.name,
      rawScore: evaluation.rawScore === null || evaluation.rawScore === undefined ? null : normalizeScore(evaluation.rawScore),
      weight: comp.weight,
      formulaStatus: comp.formulaStatus,
      status: evaluation.rawScore === null || evaluation.rawScore === undefined ? "ineligible" : evaluation.status,
      eligible: evaluation.rawScore !== null && evaluation.rawScore !== undefined,
      applicableMaximum: Number(comp.weight),
      description: comp.description || COMPONENT_DESCRIPTIONS[comp.code] || "",
      note: evaluation.note || "",
      evidence: Object.fromEntries(Object.entries(evaluation).filter(([k]) => !["rawScore", "status", "sourceRefs", "note"].includes(k))),
    });
  }
  const monthly = calculateMonthlyScore(evaluatedComponents);
  return {
    userId,
    monthlyScore: monthly.monthlyScore,
    overallScore: monthly.monthlyScore ?? 0,
    eligible: monthly.eligible,
    eligibleWeight: monthly.eligibleWeight,
    components: evaluatedComponents,
    period: { year: y, month: m },
    configurationVersion: config.version,
    calculatedAt: new Date(),
    sourceRefs: [...sourceRefs],
  };
};

const recomputeCumulativeChain = async (userId) => {
  const finals = await ScoreRepository.findFinalMonthlies(userId);
  const cumulatives = calculateCumulativeScores(
    finals.map((f) => ({ monthlyScore: f.monthlyScore ?? f.overallScore, year: f.period.year, month: f.period.month, creditWeight: f.creditWeight ?? 1 }))
  );
  for (let i = 0; i < finals.length; i += 1) {
    await ScoreRepository.upsertMonthlyScore({ userId, period: finals[i].period, cumulativeScore: cumulatives[i] });
  }
  return cumulativeWeightedAverage(finals.map((f) => ({ monthlyScore: f.monthlyScore ?? f.overallScore, creditWeight: f.creditWeight ?? 1 })));
};

const calculateScore = async (userId, opts = {}) => {
  const result = await calculateScoreForPeriod(userId, opts);
  const user = await ScoreRepository.findUser(userId);
  const finals = await ScoreRepository.findFinalMonthlies(userId);
  const finalUpTo = finals.filter((f) => f.period.year < result.period.year || (f.period.year === result.period.year && f.period.month <= result.period.month));
  const policy = isMonthEligibleForFinalization({ userCreatedAt: user?.createdAt, year: result.period.year, month: result.period.month, force: true });
  const alreadyFinal = finalUpTo.some((f) => f.period.year === result.period.year && f.period.month === result.period.month);
  const includeThisMonth = result.eligible && policy.eligible && !alreadyFinal;
  const cumulativeScore = includeThisMonth
    ? cumulativeWeightedAverage([...finalUpTo.map((f) => ({ monthlyScore: f.monthlyScore ?? f.overallScore, creditWeight: f.creditWeight ?? 1 })), { monthlyScore: result.monthlyScore, creditWeight: 1 }])
    : cumulativeWeightedAverage(finalUpTo.map((f) => ({ monthlyScore: f.monthlyScore ?? f.overallScore, creditWeight: f.creditWeight ?? 1 })));
  return { ...result, cumulativeScore };
};

const toHistoryComponents = (components) =>
  components.map((c) => ({
    code: c.code, name: c.name, rawScore: c.rawScore, weight: c.weight,
    contribution: c.eligible ? Math.round(((c.rawScore / 100) * c.weight) * 100) / 100 : 0,
    status: c.status, eligible: c.eligible, applicableMaximum: c.applicableMaximum ?? c.weight,
  }));

const updateUserScore = async (userId, trigger = "system_update") => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const result = await calculateScoreForPeriod(userId, { year, month });
  const finals = await ScoreRepository.findFinalMonthlies(userId);
  const cumulativeFinal = cumulativeWeightedAverage(finals.map((f) => ({ monthlyScore: f.monthlyScore ?? f.overallScore, creditWeight: f.creditWeight ?? 1 })));
  const displayedScore = finals.length ? cumulativeFinal : result.monthlyScore ?? 0;
  const breakdownObj = {};
  result.components.forEach((c) => { breakdownObj[c.code] = c.rawScore ?? 0; });
  await ScoreRepository.updateUserScore(userId, displayedScore, breakdownObj);
  if (result.eligible) {
    await ScoreRepository.upsertMonthlyScore({
      userId, overallScore: result.monthlyScore, monthlyScore: result.monthlyScore,
      cumulativeScore: cumulativeFinal || 0, creditWeight: 1, eligibleWeight: result.eligibleWeight,
      calculationStatus: "provisional", breakdown: breakdownObj, components: toHistoryComponents(result.components),
      configurationVersion: result.configurationVersion, calculatedAt: result.calculatedAt,
      recalculatedAt: new Date(), recalculatedReason: trigger, sourceRefs: result.sourceRefs,
      period: { year, month }, trigger,
    });
    await ScoreRepository.pushUserScoreHistory(userId, { total: displayedScore, breakdown: breakdownObj });
  }
  return { ...result, cumulativeScore: cumulativeFinal || 0, displayedScore };
};

const finalizeMonthlyScore = async (userId, { year, month, force = false, trigger = "monthly_finalize", recalculatedBy = null, recalculatedReason = null } = {}) => {
  const user = await ScoreRepository.findUser(userId);
  if (!user) throw new AppError("User not found", 404);
  const now = new Date();
  const y = Number(year) || now.getFullYear();
  const m = Number(month) || now.getMonth() + 1;
  const policy = isMonthEligibleForFinalization({ userCreatedAt: user.createdAt, year: y, month: m, force });
  if (!policy.eligible) throw new AppError(`Month ${y}-${String(m).padStart(2, "0")} is not eligible for finalization (${policy.reason}).`, 400);
  const result = await calculateScoreForPeriod(userId, { year: y, month: m });
  if (!result.eligible) throw new AppError(`Month ${y}-${String(m).padStart(2, "0")} has insufficient eligible activity to score.`, 400);
  const breakdownObj = {};
  result.components.forEach((c) => { breakdownObj[c.code] = c.rawScore ?? 0; });
  const record = await ScoreRepository.upsertMonthlyScore({
    userId, overallScore: result.monthlyScore, monthlyScore: result.monthlyScore, creditWeight: 1,
    eligibleWeight: result.eligibleWeight, calculationStatus: "final", breakdown: breakdownObj,
    components: toHistoryComponents(result.components),
    configurationVersion: result.configurationVersion, calculatedAt: result.calculatedAt,
    recalculatedAt: recalculatedReason ? new Date() : undefined,
    recalculatedBy: recalculatedReason ? recalculatedBy || undefined : undefined,
    recalculatedReason: recalculatedReason || undefined,
    sourceRefs: result.sourceRefs, period: { year: y, month: m }, trigger,
  });
  const cumulative = await recomputeCumulativeChain(userId);
  await ScoreRepository.updateUserScore(userId, cumulative, breakdownObj);
  await ScoreRepository.pushUserScoreHistory(userId, { total: cumulative, breakdown: breakdownObj });
  return { ...(record.toObject ? record.toObject() : record), cumulativeScore: cumulative };
};

const finalizeAllDueMembers = async ({ trigger = "cron" } = {}) => {
  const now = new Date();
  let prev = { year: now.getFullYear(), month: now.getMonth() };
  if (prev.month === 0) prev = { year: prev.year - 1, month: 12 };
  const members = await ScoreRepository.findAllMembersForScoring();
  let finalized = 0;
  let skipped = 0;
  for (const member of members) {
    try {
      await finalizeMonthlyScore(member._id, { ...prev, trigger });
      finalized += 1;
    } catch { skipped += 1; }
  }
  return { finalized, skipped, period: prev };
};

const getScoreSummary = async (userId) => {
  const user = await ScoreRepository.findUser(userId);
  if (!user) throw new AppError("User not found", 404);
  const now = new Date();
  const currentPeriod = { year: now.getFullYear(), month: now.getMonth() + 1 };
  const provisional = await ScoreRepository.findMonthlyRecord(userId, currentPeriod.year, currentPeriod.month);
  const finals = await ScoreRepository.findFinalMonthlies(userId);
  const lastFinal = finals.length ? finals[finals.length - 1] : null;
  const cumulativeScore = finals.length ? cumulativeWeightedAverage(finals.map((f) => ({ monthlyScore: f.monthlyScore ?? f.overallScore, creditWeight: f.creditWeight ?? 1 }))) : provisional?.monthlyScore ?? 0;
  const previousFinal = finals.length > 1 ? finals[finals.length - 2] : null;
  const currentMonthlyScore = provisional?.monthlyScore ?? lastFinal?.monthlyScore ?? null;
  const previousMonthlyScore = lastFinal?.monthlyScore ?? previousFinal?.monthlyScore ?? null;
  const change = currentMonthlyScore !== null && previousMonthlyScore !== null ? Math.round((currentMonthlyScore - previousMonthlyScore) * 100) / 100 : 0;
  return {
    cumulativeScore, currentMonthlyScore, previousMonthlyScore,
    changeFromPreviousMonth: change, currentPeriod,
    lastCalculatedAt: provisional?.calculatedAt || user.socketScoreUpdatedAt || null,
    eligibleMonths: finals.length, lastFinalPeriod: lastFinal ? lastFinal.period : null,
    configVersion: provisional?.configurationVersion || lastFinal?.configurationVersion || null,
    hasCompletedMonth: finals.length > 0, socketScore: cumulativeScore,
  };
};

const getMonthlyHistory = async (userId, limit = 24) => {
  const rows = await ScoreRepository.findMonthlyHistory(userId, limit);
  return rows.map((r, i, arr) => {
    const prev = i > 0 ? arr[i - 1] : null;
    const monthly = r.monthlyScore ?? r.overallScore;
    return {
      _id: r._id, month: r.period?.month, year: r.period?.year,
      monthlyScore: monthly, cumulativeScore: r.cumulativeScore ?? 0,
      delta: prev ? Math.round((monthly - (prev.monthlyScore ?? prev.overallScore)) * 100) / 100 : 0,
      status: r.calculationStatus, configurationVersion: r.configurationVersion,
      calculatedAt: r.calculatedAt, components: r.components,
    };
  });
};

const getTrend = async (userId, limit = 24) => {
  const history = await getMonthlyHistory(userId, limit);
  return history.map((h) => ({ month: h.month, year: h.year, monthlyScore: h.monthlyScore, cumulativeScore: h.cumulativeScore }));
};

const getExplanation = async () => {
  const config = await ScoreRepository.findActiveConfig();
  return {
    formula: "Monthly SocketScore = Σ(component performance × weight) over eligible components, renormalised to 100. Cumulative SocketScore = CGPA-style weighted average of all final monthly scores (equal credit weight per month).",
    eligibilityRule: "A component with no applicable verified evidence in a month (e.g. no loan instalments due, no withdrawals, no verified trust events) is INELIGIBLE: excluded and its weight redistributed. It is never recorded as 0 or 100.",
    components: config.components.filter((c) => c.isActive !== false).map((c) => ({ code: c.code, name: c.name, weight: c.weight, description: c.description })),
    weightsTotal: 100,
    configurationVersion: config.version,
    example: "January 80, February 90 → cumulative 85; March 70 → cumulative 80; April 100 → cumulative 85.",
  };
};

const updateScoringConfig = async (components, changeNotes, adminUserId) => {
  validateWeightedComponents(components);
  return await ScoreRepository.createConfigVersion(components, changeNotes, adminUserId);
};

const SocketScoreService = {
  calculateScore,
  calculateScoreForPeriod,
  updateUserScore,
  finalizeMonthlyScore,
  finalizeAllDueMembers,
  getScoreSummary,
  getMonthlyHistory,
  getTrend,
  getExplanation,
  getActiveConfig: () => ScoreRepository.findActiveConfig(),
  getAllConfigs: () => ScoreRepository.getAllConfigs(),
  updateScoringConfig,
  getScoreHistory: (userId, limit) => ScoreRepository.findScoreHistory(userId, limit),
  normalizeScore,
  COMPONENT_DESCRIPTIONS,
};

module.exports = { SocketScoreService };
