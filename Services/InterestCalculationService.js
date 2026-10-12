const InterestRule = require("../Models/InterestRuleModel");
const SystemSettings = require("../Models/SystemSettingsModel");
const AppError = require("../Utilis/AppError");

/**
 * Centralized Interest Calculation Service
 */
const calculateInterest = async ({
  loanType = "cooperative",
  userTier = "Bronze",
  socketScore = 0,
  principalAmount = 0,
}) => {
  if (principalAmount <= 0) {
    return {
      interestRate: 0,
      interestAmount: 0,
      ruleName: "zero_principal",
      ruleVersion: "1.0",
    };
  }

  // 1. Check for specific active configured InterestRule matching loanType, tier, and score range
  const matchedRule = await InterestRule.findOne({
    isActive: true,
    $and: [
      { $or: [{ loanType: "all" }, { loanType }] },
      { $or: [{ tier: "all" }, { tier: userTier }] },
    ],
    minSocketScore: { $lte: socketScore },
    maxSocketScore: { $gte: socketScore },
  }).sort({ priority: -1, createdAt: -1 });

  if (matchedRule) {
    const interestRate = matchedRule.interestRate;
    const interestAmount = Math.round(Number(principalAmount) * (interestRate / 100));
    return {
      interestRate,
      interestAmount,
      ruleName: matchedRule.ruleName,
      ruleVersion: matchedRule._id.toString(),
    };
  }

  // 2. Fallback to SystemSettings tier/emergency defaults
  const settings = await SystemSettings.findOne();
  let interestRate = 5;

  if (loanType === "emergency") {
    interestRate = settings?.interestRates?.emergency || 5;
  } else {
    const tierKey = (userTier || "bronze").toLowerCase();
    interestRate = settings?.interestRates?.[tierKey] || (tierKey === "platinum" ? 5 : tierKey === "gold" ? 6 : tierKey === "silver" ? 8 : 10);
  }

  const interestAmount = Math.round(Number(principalAmount) * (interestRate / 100));

  return {
    interestRate,
    interestAmount,
    ruleName: `default_${loanType}_${userTier.toLowerCase()}`,
    ruleVersion: "system_default",
  };
};

/**
 * Validate that two interest rules do not overlap ambiguously
 */
const validateRuleNoOverlap = async (newRule, excludeRuleId = null) => {
  const query = {
    isActive: true,
    loanType: newRule.loanType,
    tier: newRule.tier,
    _id: excludeRuleId ? { $ne: excludeRuleId } : { $exists: true },
  };

  const existingRules = await InterestRule.find(query);
  for (const rule of existingRules) {
    // Check if score ranges overlap
    const overlap = Math.max(newRule.minSocketScore, rule.minSocketScore) <= Math.min(newRule.maxSocketScore, rule.maxSocketScore);
    if (overlap && rule.priority === newRule.priority) {
      throw new AppError(
        `Interest rule overlaps with existing rule "${rule.ruleName}" (${rule.minSocketScore}-${rule.maxSocketScore} at priority ${rule.priority}). Adjust score range or priority.`,
        400
      );
    }
  }
};

const InterestCalculationService = {
  calculateInterest,
  validateRuleNoOverlap,
  getRules: (filter = {}) => InterestRule.find(filter).sort({ priority: -1, createdAt: -1 }),
  createRule: async (ruleData, userId) => {
    await validateRuleNoOverlap(ruleData);
    return await InterestRule.create({ ...ruleData, createdBy: userId });
  },
  updateRule: async (ruleId, updates) => {
    const rule = await InterestRule.findById(ruleId);
    if (!rule) throw new AppError("Interest rule not found", 404);
    await validateRuleNoOverlap({ ...rule.toObject(), ...updates }, ruleId);
    return await InterestRule.findByIdAndUpdate(ruleId, updates, { new: true });
  },
  deleteRule: async (ruleId) => {
    return await InterestRule.findByIdAndDelete(ruleId);
  },
};

module.exports = { InterestCalculationService };
