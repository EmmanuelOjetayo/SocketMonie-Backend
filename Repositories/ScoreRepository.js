const ScoreConfig = require("../Models/ScoreConfigModel");
const ScoreHistory = require("../Models/ScoreHistory");
const User = require("../Models/UserModel");
const Savings = require("../Models/SavingsModel");
const Loan = require("../Models/LoanModel");
const Referral = require("../Models/ReferralModel");

const defaultComponents = [
  {
    code: "savings_consistency",
    name: "Savings Discipline",
    weight: 35,
    calculationRule: "savings_consistency_6m",
    description: "Existing six-month contribution-ratio assumption; formula requires business approval.",
    formulaStatus: "assumption",
    isActive: true,
  },
  {
    code: "savings_growth",
    name: "Savings Growth",
    weight: 15,
    calculationRule: "savings_growth",
    description: "Reserved for an approved savings-growth formula.",
    formulaStatus: "unconfigured",
    isActive: true,
  },
  {
    code: "loan_repayment",
    name: "Repayment Consistency",
    weight: 20,
    calculationRule: "loan_repayment_timeliness",
    description: "Existing installment-timeliness assumption; formula requires business approval.",
    formulaStatus: "assumption",
    isActive: true,
  },
  {
    code: "withdrawal_behaviour",
    name: "Withdrawal Behaviour",
    weight: 10,
    calculationRule: "withdrawal_behaviour",
    description: "Reserved for an approved withdrawal-behaviour formula.",
    formulaStatus: "unconfigured",
    isActive: true,
  },
  {
    code: "profile_completion",
    name: "Profile Completion",
    weight: 5,
    calculationRule: "profile_completion",
    description: "Reserved for an approved profile-completion formula.",
    formulaStatus: "unconfigured",
    isActive: true,
  },
  {
    code: "community_trust",
    name: "Community Trust",
    weight: 15,
    calculationRule: "community_trust",
    description: "Reserved for an approved community-trust formula.",
    formulaStatus: "unconfigured",
    isActive: true,
  },
];

const ScoreRepository = {
  findActiveConfig: async () => {
    let config = await ScoreConfig.findOne({ isActive: true }).sort({ version: -1 });
    const hasSixComponents = config?.components?.filter((component) => component.isActive !== false).length === 6;
    if (!config || !hasSixComponents) {
      if (config) await ScoreConfig.updateMany({ isActive: true }, { $set: { isActive: false } });
      config = await ScoreConfig.create({
        version: (await ScoreConfig.findOne().sort({ version: -1 }))?.version + 1 || 1,
        isActive: true,
        components: defaultComponents,
        totalWeight: 100,
        changeNotes: "System initial scoring configuration",
      });
    }
    return config;
  },

  getAllConfigs: () => ScoreConfig.find().sort({ version: -1 }),

  createConfigVersion: async (components, changeNotes, updatedBy) => {
    const latest = await ScoreConfig.findOne().sort({ version: -1 });
    const nextVersion = (latest?.version || 0) + 1;

    // Deactivate previous
    await ScoreConfig.updateMany({}, { isActive: false });

    return await ScoreConfig.create({
      version: nextVersion,
      isActive: true,
      components,
      totalWeight: components.filter((c) => c.isActive !== false).reduce((a, b) => a + b.weight, 0),
      changeNotes: changeNotes || `Version ${nextVersion}`,
      updatedBy,
    });
  },

  findUser: (userId) => User.findById(userId),

  findUserDepositsSince: (userId, sinceDate) =>
    Savings.find({
      userId,
      type: "deposit",
      status: "completed",
      createdAt: { $gte: sinceDate },
    }),

  findUserLoans: (userId) => Loan.find({ userId }),

  countQualifiedReferrals: (userId) =>
    Referral.countDocuments({ referrerId: userId, status: { $in: ["qualified", "rewarded"] } }),

  updateUserScore: (userId, socketScore, breakdown) =>
    User.findByIdAndUpdate(
      userId,
      {
        socketScore,
        socketScoreBreakdown: breakdown,
        socketScoreUpdatedAt: new Date(),
      },
      { new: true }
    ),

  createScoreHistory: (historyData) => ScoreHistory.create(historyData),

  findScoreHistory: (userId, limit = 12) =>
    ScoreHistory.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean(),
};

module.exports = { ScoreRepository };
