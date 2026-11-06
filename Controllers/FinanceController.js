const Savings = require("../Models/SavingsModel");
const Loan = require("../Models/LoanModel");

// Month-over-month growth helper (real data, no fabricated rates).
const computeMoMGrowth = async (matchBase) => {
  const now = new Date();
  const startCurrent = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const endPrev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));

  const sumBetween = async (start, end) => {
    const [row] = await Savings.aggregate([
      { $match: { ...matchBase, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    return row?.total || 0;
  };

  const previous = await sumBetween(startPrev, endPrev);
  const current = await sumBetween(startCurrent, now);
  if (previous <= 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
};

exports.getOverview = async (req, res, next) => {
  try {
    const totalSavings = await Savings.aggregate([
      { $match: { type: "deposit", status: "completed" } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const activeLoans = await Loan.find({ status: { $in: ["active", "warning_30_days", "defaulted_60_days", "restricted_90_days", "recovery_120_days"] } });
    const activeLoansTotal = activeLoans.reduce((sum, l) => sum + l.remainingBalance, 0);
    // Total repayments received = every naira actually paid back, from all
    // loans (partial repayments on active loans included — not just completed
    // loans, which understated collections).
    const totalRepayments = await Loan.aggregate([
      { $match: { amountPaid: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$amountPaid" } } }
    ]);
    const recentTransactions = await Savings.find({ status: "completed" })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("userId", "fullName email");
    const [savingsGrowth, repaymentGrowth] = await Promise.all([
      computeMoMGrowth({ type: "deposit", status: "completed" }),
      computeMoMGrowth({ type: "loan_repayment", status: "completed" }),
    ]);
    const stats = {
      totalSavings: totalSavings[0]?.total || 0,
      savingsGrowth,
      activeLoansCount: activeLoans.length,
      activeLoansTotal,
      totalRepayments: totalRepayments[0]?.total || 0,
      repaymentGrowth,
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