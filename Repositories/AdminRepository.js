const User = require("../Models/UserModel");
const Loan = require("../Models/LoanModel");
const Savings = require("../Models/SavingsModel");
const ScoreHistory = require("../Models/ScoreHistory");
const SystemSettings = require("../Models/SystemSettingsModel");

const AdminRepository = {
  findMembers: (query, skip, limit) =>
    User.find(query).select("-password").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),

  countUsers: (query) => User.countDocuments(query),

  findMember: (userId) => User.findById(userId).select("-password").lean(),

  findUserDocument: (userId, session = null) => {
    const query = User.findById(userId);
    if (session) query.session(session);
    return query;
  },

  findSavings: (query) => Savings.find(query),

  findWithdrawals: (query, skip, limit) =>
    Savings.find(query)
      .populate("userId", "fullName email phone")
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit),

  countSavings: (query) => Savings.countDocuments(query),

  findWithdrawalById: (id, session = null) => {
    const query = Savings.findById(id);
    if (session) query.session(session);
    return query;
  },

  findLoans: (query, skip, limit) =>
    Loan.find(query).populate("userId", "fullName email phone").sort({ createdAt: -1 }).skip(skip).limit(limit),

  countLoans: (query) => Loan.countDocuments(query),

  findLoan: (loanId) =>
    Loan.findById(loanId).populate("userId", "fullName email phone address occupation bankDetails kycStatus"),

  findPendingLoan: (loanId) =>
    Loan.findOne({ _id: loanId, status: "pending_review" }).populate("userId", "fullName email"),

  findScoreHistory: (userId) => ScoreHistory.find({ userId }).sort({ createdAt: -1 }).limit(20).lean(),

  findSettings: () => SystemSettings.findOne(),

  createSettings: (data) => SystemSettings.create(data),

  findTierRequests: (query, skip, limit) =>
    User.find(query)
      .select("fullName email tier tierUpgradeRequest")
      .sort({ "tierUpgradeRequest.submittedAt": -1 })
      .skip(skip)
      .limit(limit),

  findSavingsReport: (filter = {}) => Savings.find(filter).populate("userId", "fullName").sort({ createdAt: -1 }),

  findLoanReport: () => Loan.find().populate("userId", "fullName").sort({ createdAt: -1 }),

  findActiveLoanReport: () => Loan.find({ status: "active" }).populate("userId", "fullName"),

  getOverviewAggregates: async () => {
    const [totalMembers, totalSavingsRes, totalLoansDisbursedRes, totalRevenueRes] = await Promise.all([
      User.countDocuments(),
      Savings.aggregate([
        { $match: { status: "completed", type: { $in: ["deposit", "withdrawal"] } } },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $cond: [{ $eq: ["$type", "withdrawal"] }, { $multiply: ["$amount", -1] }, "$amount"],
              },
            },
          },
        },
      ]),
      Loan.aggregate([
        { $match: { status: "active" } },
        { $group: { _id: null, total: { $sum: "$principalAmount" } } },
      ]),
      Loan.aggregate([
        { $match: { status: "active" } },
        { $group: { _id: null, total: { $sum: "$interestAmount" } } },
      ]),
    ]);

    return {
      totalMembers,
      totalSavings: totalSavingsRes[0]?.total || 0,
      totalLoansDisbursed: totalLoansDisbursedRes[0]?.total || 0,
      totalRevenue: totalRevenueRes[0]?.total || 0,
    };
  },

  saveDocument: (doc, session = null) => {
    if (session) return doc.save({ session });
    return doc.save();
  },
};

module.exports = { AdminRepository };