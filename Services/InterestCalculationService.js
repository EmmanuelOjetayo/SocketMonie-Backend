const AppError = require("../Utilis/AppError");
const { LOAN_INTEREST_RATE } = require("../Config/constants");

/**
 * Centralized Interest Calculation Service
 *
 * BUSINESS RULE (2026-10): Every new loan is priced at a FIXED 2% flat rate
 * on the requested amount. The interest is collected UPFRONT by deducting it
 * from the loan proceeds at payout and is NOT charged again during repayment
 * (the member repays the approved principal only).
 *
 * The lookup-based pricing paths (InterestRule documents, tier-based
 * SystemSettings rates) are intentionally bypassed so an admin-configurable
 * rule can never move a new loan off the fixed 2% rate.
 *
 * Legacy admin rule-CRUD (below) still reads/writes InterestRule documents for
 * reporting/audit, but is loaded lazily: the pricing path is a pure function
 * and must not pull a mongoose model into every loan-application request.
 */
const LOAN_INTEREST_RULE_NAME = "fixed_flat_2_percent";
const LOAN_INTEREST_RULE_VERSION = "1.0";

let InterestRule = null;
const getRuleModel = () => {
  if (!InterestRule) InterestRule = require("../Models/InterestRuleModel");
  return InterestRule;
};

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

  // Fixed flat rate: interest = requestedLoanAmount * 0.02
  const interestRate = LOAN_INTEREST_RATE;
  const interestAmount = Math.round(Number(principalAmount) * (interestRate / 100));

  return {
    interestRate,
    interestAmount,
    ruleName: LOAN_INTEREST_RULE_NAME,
    ruleVersion: LOAN_INTEREST_RULE_VERSION,
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

  const existingRules = await getRuleModel().find(query);
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
  getRules: (filter = {}) => getRuleModel().find(filter).sort({ priority: -1, createdAt: -1 }),
  createRule: async (ruleData, userId) => {
    await validateRuleNoOverlap(ruleData);
    return await getRuleModel().create({ ...ruleData, createdBy: userId });
  },
  updateRule: async (ruleId, updates) => {
    const rule = await getRuleModel().findById(ruleId);
    if (!rule) throw new AppError("Interest rule not found", 404);
    await validateRuleNoOverlap({ ...rule.toObject(), ...updates }, ruleId);
    return await getRuleModel().findByIdAndUpdate(ruleId, updates, { new: true });
  },
  deleteRule: async (ruleId) => {
    return await getRuleModel().findByIdAndDelete(ruleId);
  },
};

module.exports = { InterestCalculationService };
