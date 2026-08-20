const Savings = require("../Models/SavingsModel");
const Loan = require("../Models/LoanModel");

exports.getOverview = async (req, res, next) => {
  try {
    const totalSavings = await Savings.aggregate([
      { $match: { type: "deposit", status: "completed" } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const activeLoans = await Loan.find({ status: "active" });
    const activeLoansTotal = activeLoans.reduce((sum, l) => sum + l.remainingBalance, 0);
    const totalRepayments = await Loan.aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: null, total: { $sum: "$amountPaid" } } }
    ]);
    const recentTransactions = await Savings.find({ status: "completed" })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("userId", "fullName email");
    const stats = {
      totalSavings: totalSavings[0]?.total || 0,
      savingsGrowth: 8,
      activeLoansCount: activeLoans.length,
      activeLoansTotal,
      totalRepayments: totalRepayments[0]?.total || 0,
      repaymentGrowth: 5,
      recentTransactions: recentTransactions.map(tx => ({
        description: tx.type === "deposit" ? "Savings Deposit" : "Withdrawal",
        amount: tx.amount,
        user: tx.userId?.fullName || "Unknown",
        createdAt: tx.createdAt,
      })),
    };
    return res.status(200).json({ success: true, stats });
  } catch (err) { next(err); }
};

exports.getSavings = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const total = await Savings.countDocuments({ status: "completed" });
    const savings = await Savings.find({ status: "completed" })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("userId", "fullName email");
    return res.status(200).json({ success: true, data: savings, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
};

exports.getRepayments = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const total = await Loan.countDocuments({ status: "completed" });
    const loans = await Loan.find({ status: "completed" })
      .sort({ completedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("userId", "fullName email");
    return res.status(200).json({ success: true, data: loans, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
};