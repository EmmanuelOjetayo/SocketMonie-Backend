const Savings = require("../Models/SavingsModel");
const User = require("../Models/UserModel");

const SavingsRepository = {
  findCompletedForUser: (userId) => Savings.find({ userId, status: "completed" }).sort({ createdAt: -1 }),

  findForUser: (userId, skip, limit) =>
    Savings.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),

  countForUser: (userId) => Savings.countDocuments({ userId }),

  findUserById: (userId) => User.findById(userId),

  findUserSummary: (userId) => User.findById(userId).select("tier monthlySavingsCommitment currentTier fullName email phone transactionPin membershipFeePaid membershipFeeTxRef membershipFeePaidAt bankDetails"),

  createSavingsRecord: (data, session = null) => {
    if (session) {
      return Savings.create([data], { session }).then((docs) => docs[0]);
    }
    return Savings.create(data);
  },

  getNetSavings: async (userId) => {
    const completedSavings = await Savings.find({ userId, status: "completed" });
    return completedSavings.reduce((sum, item) => {
      if (item.type === "withdrawal") return sum - item.amount;
      if (item.type === "deposit") return sum + item.amount;
      return sum;
    }, 0);
  },

  findCompletedDepositsSince: (userId, sinceDate) =>
    Savings.find({
      userId,
      type: "deposit",
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