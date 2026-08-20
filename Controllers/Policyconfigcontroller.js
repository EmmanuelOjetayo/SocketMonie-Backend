const PolicyConfig = require("../Models/PolicyConfigModel");
const { logAudit } = require("../Utilis/auditLog");

// Ensures exactly one PolicyConfig document always exists (creates defaults on first read)
const getOrCreatePolicy = async () => {
  let policy = await PolicyConfig.findOne({ singleton: true });
  if (!policy) {
    policy = await PolicyConfig.create({});
  }
  return policy;
};

// GET /api/policy — public-ish read (behind normal auth) used by onboarding + profile pages
const getPolicy = async (req, res, next) => {
  try {
    const policy = await getOrCreatePolicy();
    return res.status(200).json({ success: true, policy });
  } catch (error) {
    next(error);
  }
};

// PUT /api/policy — Super Admin only
const updatePolicy = async (req, res, next) => {
  try {
    const policy = await getOrCreatePolicy();

    const {
      tiers,
      loanTierPercentages,
      guarantorRequiredAbovePercentage,
      savingsConsistencyMonthsRequired,
      minNetSavingsForLoanEligibility,
    } = req.body;

    const before = policy.toObject();

    if (tiers) policy.tiers = tiers;
    if (loanTierPercentages) {
      policy.loanTierPercentages = {
        ...policy.loanTierPercentages.toObject(),
        ...loanTierPercentages,
      };
    }
    if (guarantorRequiredAbovePercentage !== undefined) {
      policy.guarantorRequiredAbovePercentage = guarantorRequiredAbovePercentage;
    }
    if (savingsConsistencyMonthsRequired !== undefined) {
      policy.savingsConsistencyMonthsRequired = savingsConsistencyMonthsRequired;
    }
    if (minNetSavingsForLoanEligibility !== undefined) {
      policy.minNetSavingsForLoanEligibility = minNetSavingsForLoanEligibility;
    }

    policy.updatedBy = req.user._id;
    await policy.save();

    await logAudit({
      actorId: req.user._id,
      actorRole: req.user.role,
      action: "policy_config_updated",
      targetType: "PolicyConfig",
      targetId: policy._id,
      metadata: { before, after: policy.toObject() },
    });

    return res.status(200).json({
      success: true,
      message: "Policy configuration updated.",
      policy,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getPolicy,
  updatePolicy,
  getOrCreatePolicy,
};