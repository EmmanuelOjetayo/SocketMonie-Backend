const ScoreConfig = require("../Models/ScoreConfigModel");
const ScoreHistory = require("../Models/ScoreHistory");
const User = require("../Models/UserModel");
const Savings = require("../Models/SavingsModel");
const Loan = require("../Models/LoanModel");
const Referral = require("../Models/ReferralModel");

const defaultComponents = [
  {
    code: "savings_consistency",
    name: "Savings Consistency",
    weight: 35,
    calculationRule: "savings_consistency_6m",
    description: "Verified savings deposits this month / monthly savings commitment (tier minimum fallback).",
    formulaStatus: "approved",
    isActive: true,
  },
  {
    code: "savings_growth",
    name: "Savings Growth",
    weight: 15,
    calculationRule: "savings_growth",
    description: "Monthly net savings growth vs opening balance; 10% monthly growth earns full marks.",
    formulaStatus: "approved",
    isActive: true,
  },
  {
    code: "loan_repayment",
    name: "Loan Repayment",
    weight: 20,
    calculationRule: "loan_repayment_timeliness",
    description: "Share of instalments due this month that were paid on time.",
    formulaStatus: "approved",
    isActive: true,
  },
  {
    code: "withdrawal_behaviour",
    name: "Withdrawal Behaviour",
    weight: 10,
    calculationRule: "withdrawal_behaviour",
    description: "Withdrawals relative to opening balance; withdrawing up to 20% of balance earns full marks.",
    formulaStatus: "approved",
    isActive: true,
  },
  {
    code: "profile_completion",
    name: "Profile Completion",
    weight: 5,
    calculationRule: "profile_completion",
    description: "Verified personal info, verified bank details and approved KYC.",
    formulaStatus: "approved",
    isActive: true,
  },
  {
    code: "community_trust",
    name: "Community Trust",
    weight: 15,
    calculationRule: "community_trust",
    description: "Qualified referrals (70%, target 5) and verified guarantor participation (30%, target 2).",
    formulaStatus: "approved",
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

  findAllMembersForScoring: () =>
    User.find({ role: "member", status: { $ne: "suspended" } }).select("_id createdAt"),

  findUserDepositsSince: (userId, sinceDate) =>
    Savings.find({
      userId,
      type: "deposit",
      status: "completed",
      createdAt: { $gte: sinceDate },
    }),

  /** Verified deposits inside one calendar month only. */
  findUserDepositsInRange: (userId, start, end) =>
    Savings.find({
      userId,
      type: "deposit",
      status: "completed",
      createdAt: { $gte: start, $lt: end },
    }),

  /** Verified withdrawals inside one calendar month only. */
  findUserWithdrawalsInRange: (userId, start, end) =>
    Savings.find({
      userId,
      type: "withdrawal",
      status: "completed",
      createdAt: { $gte: start, $lt: end },
    }),

  /**
   * Net verified savings balance immediately BEFORE `date`.
   * Deposits add, withdrawals subtract. Loan repayments and loan
   * disbursements are deliberately excluded — money received from a loan
   * is not savings growth.
   */
  findNetBalanceBefore: async (userId, date) => {
    const records = await Savings.find({
      userId,
      type: { $in: ["deposit", "withdrawal"] },
      status: "completed",
      createdAt: { $lt: date },
    }).select("type amount");
    return records.reduce(
      (sum, r) => sum + (r.type === "withdrawal" ? -Number(r.amount || 0) : Number(r.amount || 0)),
      0
    );
  },

  findUserLoans: (userId) => Loan.find({ userId }),

  countQualifiedReferrals: (userId) =>
    Referral.countDocuments({ referrerId: userId, status: { $in: ["qualified", "rewarded"] } }),

  countQualifiedReferralsUpTo: (userId, end) =>
    Referral.countDocuments({
      referrerId: userId,
      status: { $in: ["qualified", "rewarded"] },
      qualifiedAt: { $lte: end },
    }),

  /** Count of loans where this member is a verified guarantor. */
  countGuarantorParticipations: (userId) =>
    Loan.countDocuments({
      $or: [
        { "guarantors.userId": userId, "guarantors.status": { $in: ["accepted", "active"] } },
        { "guarantor.guarantorUserId": userId, "guarantor.status": { $in: ["accepted", "active"] } },
      ],
    }),

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

  /** Append to the legacy per-user history array (kept for backward compat). */
  pushUserScoreHistory: (userId, entry) =>
    User.findByIdAndUpdate(userId, { $push: { socketScoreHistory: entry } }, { new: false }),

  createScoreHistory: (historyData) => ScoreHistory.create(historyData),

  /**
   * Idempotent monthly upsert: one record per member + year + month.
   * Re-running for the same month overwrites with the fresh calculation
   * instead of appending duplicates.
   */
  upsertMonthlyScore: (doc) =>
    ScoreHistory.findOneAndUpdate(
      { userId: doc.userId, "period.year": doc.period.year, "period.month": doc.period.month },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ),

  findMonthlyRecord: (userId, year, month) =>
    ScoreHistory.findOne({ userId, "period.year": year, "period.month": month }).lean(),

  findFinalMonthlies: (userId) =>
    ScoreHistory.find({ userId, calculationStatus: "final" })
      .sort({ "period.year": 1, "period.month": 1 })
      .lean(),

  findScoreHistory: (userId, limit = 12) =>
    ScoreHistory.find({ userId }).sort({ "period.year": -1, "period.month": -1 }).limit(limit).lean(),

  findMonthlyHistory: (userId, limit = 24) =>
    ScoreHistory.find({ userId })
      .sort({ "period.year": 1, "period.month": 1 })
      .limit(limit)
      .lean(),
};

module.exports = { ScoreRepository };
