const mongoose = require("mongoose");
const Savings = require("../Models/SavingsModel");
const User = require("../Models/UserModel");

// Savings balances/reports/history must never include SocketMinutes checkout
// records, even legacy records written before model separation was enforced.
const SAVINGS_LEDGER_SCOPE = {
  type: { $in: ["deposit", "withdrawal"] },
  category: { $ne: "minutes_payment" },
};

const SavingsRepository = {
  findCompletedForUser: (userId) =>
    Savings.find({ userId, status: "completed", ...SAVINGS_LEDGER_SCOPE }).sort({ createdAt: -1 }),

  findForUser: (userId, skip, limit) => {
    const userObjectId = mongoose.Types.ObjectId.isValid(String(userId))
      ? new mongoose.Types.ObjectId(String(userId))
      : userId;
    return Savings.aggregate([
      { $match: { userId: userObjectId, ...SAVINGS_LEDGER_SCOPE } },
      { $addFields: { _historySortDate: { $ifNull: ["$historyDisplayAt", "$createdAt"] } } },
      { $sort: { _historySortDate: -1, _id: -1 } },
      { $skip: skip },
      { $limit: limit },
      { $project: { _historySortDate: 0 } },
    ]);
  },

  countForUser: (userId) => Savings.countDocuments({ userId, ...SAVINGS_LEDGER_SCOPE }),

  findUserById: (userId) => User.findById(userId),

  findUserSummary: (userId) => User.findById(userId).select("tier monthlySavingsCommitment currentTier fullName email phone transactionPin membershipFeePaid membershipFeeTxRef membershipFeePaidAt bankDetails"),

  createSavingsRecord: (data, session = null) => {
    if (session) {
      return Savings.create([data], { session }).then((docs) => docs[0]);
    }
    return Savings.create(data);
  },

  getNetSavings: async (userId) => {
    const completedSavings = await Savings.find({ userId, status: "completed", ...SAVINGS_LEDGER_SCOPE });
    return completedSavings.reduce((sum, item) => {
      if (item.type === "withdrawal") return sum - item.amount;
      if (item.type === "deposit") return sum + item.amount;
      return sum;
    }, 0);
  },

  // Withdrawal reservations that have not yet hit a "completed" record:
  // pending admin approval or approved-but-not-paid-out (P2-002 double-spend fix).
  getPendingWithdrawalDeductions: async (userId) => {
    const pending = await Savings.find({
      userId,
      type: "withdrawal",
      status: { $in: ["pending_approval", "approved"] },
    });
    return pending.reduce(
      (sum, item) => sum + Number(item.amount) + Number(item.fee || 0),
      0
    );
  },

  findCompletedDepositsSince: (userId, sinceDate) =>
    Savings.find({
      userId,
      type: "deposit",
      category: { $ne: "minutes_payment" },
      status: "completed",
      createdAt: { $gte: sinceDate },
    }),

  findAdminsForNotification: () =>
    User.find({
      role: { $in: ["super_admin", "finance_manager"] },
      status: { $ne: "suspended" },
    }).select("_id"),

  updateUser: (userId, updateData, session = null) => {
    const options = { new: true, runValidators: true };
    if (session) options.session = session;
    return User.findByIdAndUpdate(userId, updateData, options);
  },
};

module.exports = { SavingsRepository };