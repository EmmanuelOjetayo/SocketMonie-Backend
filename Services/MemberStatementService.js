const Savings = require("../Models/SavingsModel");
const Loan = require("../Models/LoanModel");
const ScoreHistory = require("../Models/ScoreHistory");
const TransactionService = require("./TransactionService");
const AppError = require("../Utilis/AppError");

/**
 * MemberStatementService — the single source of truth for a member's
 * monthly financial statement. Both the JSON endpoint
 * (GET /api/reports/monthly) and the PDF download
 * (GET /api/reports/download-pdf) build their payloads from here, so the
 * numbers on the Reports page can never disagree with the PDF statement.
 *
 * Financial-integrity rules:
 *  - Totals only ever count `completed` savings records. Pending/failed/
 *    pending_approval records are listed with their real status but never
 *    folded into money totals.
 *  - Loan figures come from the LoanModel itself (no frontend-supplied data).
 *  - Rating comes from the member's live SocketScore and the ScoreHistory
 *    record for the previous calendar month (null when none exists — never
 *    fabricated).
 */

// Loan statuses that represent money still owed by the member (the real
// escalation chain — "defaulted" alone is not a valid LoanModel status).
const ACTIVE_LOAN_STATUSES = [
  "active",
  "warning_30_days",
  "defaulted_60_days",
  "restricted_90_days",
  "recovery_120_days",
];

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested)                                          */
/* ------------------------------------------------------------------ */

/**
 * UTC month boundaries for a calendar month, plus the previous calendar
 * month's boundaries (handles year rollover and leap years correctly).
 */
const monthRange = (year, month) => {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (!y || !m || m < 1 || m > 12 || y < 1970 || y > 2999) return null;

  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  const prevStart = new Date(Date.UTC(prevYear, prevMonth - 1, 1));
  const prevEnd = new Date(Date.UTC(prevYear, prevMonth, 0, 23, 59, 59, 999));

  return { start, end, prevMonth, prevYear, prevStart, prevEnd };
};

/**
 * Sum of `amount` over records whose status is exactly `completed`.
 */
const sumCompleted = (records) =>
  records
    .filter((r) => r.status === "completed")
    .reduce((sum, r) => sum + Number(r.amount || 0), 0);

/**
 * Growth rate vs previous month, mirroring the long-standing reports rule:
 * previous 0 + current > 0 → 100 (new saving activity), otherwise the
 * percentage change (0 when nothing was saved in either month).
 */
const calculateGrowthRate = (current, previous) => {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
};

/**
 * Pick the best available score reading from a ScoreHistory row.
 * monthlyScore (new CGPA model) wins, then the legacy mirror, then the
 * cumulative average. Returns null for a missing row — callers must not
 * invent a score.
 */
const pickScore = (row) => {
  if (!row) return null;
  if (row.monthlyScore != null) return row.monthlyScore;
  if (row.overallScore != null) return row.overallScore;
  if (row.cumulativeScore != null) return row.cumulativeScore;
  return null;
};

/* ------------------------------------------------------------------ */
/* Statement builder                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build the full monthly statement for a member.
 *
 * @param {Object} user      auth user document (socketScore/tier/name/email)
 * @param {number} month     1-12
 * @param {number} year      e.g. 2026
 * @returns {Object} statement payload (JSON-ready, plain values)
 */
const buildMonthlyStatement = async (user, month, year) => {
  const range = monthRange(year, month);
  if (!range) {
    // Input validation errors must surface as 400, not as unhandled 500s.
    const err = new AppError("Invalid month or year for statement", 400);
    throw err;
  }

  const userId = user._id;

  /* --- Savings (month-scoped) ------------------------------------- */
  const monthRecords = await Savings.find({
    userId,
    createdAt: { $gte: range.start, $lte: range.end },
  })
    .select("amount type status method reference category createdAt")
    .lean();

  const prevRecords = await Savings.find({
    userId,
    status: "completed",
    type: "deposit",
    createdAt: { $gte: range.prevStart, $lte: range.prevEnd },
  })
    .select("amount")
    .lean();

  const totalDeposits = sumCompleted(
    monthRecords.filter((r) => r.type === "deposit")
  );
  const totalWithdrawals = sumCompleted(
    monthRecords.filter((r) => r.type === "withdrawal")
  );
  const prevTotalSaved = prevRecords.reduce(
    (sum, r) => sum + Number(r.amount || 0),
    0
  );

  const totalSaved = totalDeposits; // month-scoped savings, as always
  const netGrowth = totalDeposits - totalWithdrawals;
  const growthRate = calculateGrowthRate(totalSaved, prevTotalSaved);

  /* --- Loans ------------------------------------------------------- */
  // Active positions (money still owed), any start date.
  const activeLoans = await Loan.find({
    userId,
    status: { $in: ACTIVE_LOAN_STATUSES },
  })
    .select("principalAmount remainingBalance interestAmount amountPaid loanNumber")
    .lean();

  const outstandingBalance = activeLoans.reduce(
    (sum, l) => sum + Number(l.remainingBalance || 0),
    0
  );
  const activePrincipal = activeLoans.reduce(
    (sum, l) => sum + Number(l.principalAmount || 0),
    0
  );
  const activeInterest = activeLoans.reduce(
    (sum, l) => sum + Number(l.interestAmount || 0),
    0
  );

  // Lifetime repayments across ALL loans (active + completed) — the real
  // "Total Paid Off" figure, not month-scoped.
  const repaidAgg = await Loan.aggregate([
    { $match: { userId } },
    { $group: { _id: null, total: { $sum: "$amountPaid" } } },
  ]);
  const totalRepaid = repaidAgg[0]?.total || 0;

  /* --- SocketScore rating ----------------------------------------- */
  const currentScore = user.socketScore ?? 0;
  const prevScoreRow = await ScoreHistory.findOne({
    userId,
    "period.year": range.prevYear,
    "period.month": range.prevMonth,
  })
    .select("monthlyScore overallScore cumulativeScore")
    .lean();
  const previousScore = pickScore(prevScoreRow);

  /* --- Unified transaction history (month-scoped) ------------------ */
  const { transactions } = await TransactionService.list({
    userId,
    month,
    year,
    type: "all",
    limit: 100,
  });

  return {
    period: { month: Number(month), year: Number(year) },
    savings: {
      totalSaved,
      totalDeposits,
      totalWithdrawals,
      netGrowth,
      growthRate,
    },
    loans: {
      activeLoansCount: activeLoans.length,
      activeCount: activeLoans.length, // alias used by the Reports page
      outstandingBalance,
      principalAmount: activePrincipal,
      interestAmount: activeInterest,
      amountPaid: totalRepaid,
      totalRepaid,
    },
    rating: {
      current: currentScore,
      previous: previousScore, // null when no previous month record exists
      tier: user.tier || "Unassigned",
    },
    transactions,
  };
};

module.exports = {
  buildMonthlyStatement,
  monthRange,
  sumCompleted,
  calculateGrowthRate,
  pickScore,
  ACTIVE_LOAN_STATUSES,
};
