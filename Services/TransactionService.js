const mongoose = require("mongoose");

const SavingsTransaction = require("../Models/SavingsTransactionModel");
const MinuteTransaction = require("../Models/MinuteTransactionModel");
const MembershipTransaction = require("../Models/MembershipTransactionModel");
const LoanTransaction = require("../Models/LoanTransactionModel");

// Legacy collections — the read API merges these with the dedicated
// transaction models so records created before the models existed remain
// visible (no destructive migration required).
const Savings = require("../Models/SavingsModel");
const User = require("../Models/UserModel");
const { MEMBERSHIP_FEE_AMOUNT } = require("../Config/constants");

/**
 * TransactionService — unified, filtered transaction history.
 *
 * Design goals:
 *  - One read model for savings / minutes / membership / loan payments.
 *  - Additive: writes happen at settlement points and never alter the
 *    existing Savings / Minutes / User / Loan flows.
 *  - Backward compatible: legacy records are merged in and de-duplicated
 *    by reference, so no historical transaction disappears.
 */

const MODELS = {
  savings: SavingsTransaction,
  minute: MinuteTransaction,
  membership: MembershipTransaction,
  loan: LoanTransaction,
};

const LABELS = {
  savings: { deposit: "Savings Deposit", withdrawal: "Withdrawal", default: "Savings" },
  minute: { minute_contribution: "SocketMinutes Contribution", default: "SocketMinutes" },
  membership: { membership_fee: "Membership Fee", default: "Membership" },
  loan: { loan_repayment: "Loan Repayment", loan_disbursement: "Loan Disbursement", default: "Loan" },
};

const isValidType = (t) => Object.prototype.hasOwnProperty.call(MODELS, t);

/* ------------------------------------------------------------------ */
/* Idempotent record helpers (dual-write at settlement points)         */
/* ------------------------------------------------------------------ */

const upsertByReference = async (Model, reference, data) => {
  if (!reference) return null;
  return Model.findOneAndUpdate(
    { reference },
    { $set: { ...data, reference } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

const safeRecord = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    // Transaction recording must NEVER break a settled payment.
    console.error(`[TRANSACTION] ${label} failed:`, err?.message || err);
    return null;
  }
};

const recordSavingsTransaction = (data) =>
  safeRecord("recordSavingsTransaction", () =>
    upsertByReference(SavingsTransaction, data.reference, {
      userId: data.userId,
      type: data.type,
      reference: data.reference,
      transactionId: data.transactionId || null,
      amount: data.amount,
      fee: data.fee || 0,
      currency: data.currency || "NGN",
      status: data.status || "completed",
      method: data.method || "flutterwave",
      paidAt: data.paidAt || new Date(),
      metadata: data.metadata || {},
    })
  );

const recordMinuteTransaction = (data) =>
  safeRecord("recordMinuteTransaction", () =>
    upsertByReference(MinuteTransaction, data.reference, {
      userId: data.userId,
      type: "minute_contribution",
      reference: data.reference,
      transactionId: data.transactionId || null,
      amount: data.amount,
      currency: data.currency || "NGN",
      status: data.status || "completed",
      method: data.method || "flutterwave",
      paidAt: data.paidAt || new Date(),
      metadata: data.metadata || {},
    })
  );

const recordMembershipTransaction = (data) =>
  safeRecord("recordMembershipTransaction", () =>
    upsertByReference(MembershipTransaction, data.reference, {
      userId: data.userId,
      type: "membership_fee",
      reference: data.reference,
      transactionId: data.transactionId || null,
      amount: data.amount,
      currency: data.currency || "NGN",
      status: data.status || "completed",
      method: data.method || "flutterwave",
      paidAt: data.paidAt || new Date(),
      metadata: data.metadata || {},
    })
  );

const recordLoanTransaction = (data) =>
  safeRecord("recordLoanTransaction", () =>
    upsertByReference(LoanTransaction, data.reference, {
      userId: data.userId,
      loanId: data.loanId || null,
      type: data.type || "loan_repayment",
      reference: data.reference,
      transactionId: data.transactionId || null,
      amount: data.amount,
      currency: data.currency || "NGN",
      status: data.status || "completed",
      method: data.method || "flutterwave",
      paidAt: data.paidAt || new Date(),
      metadata: data.metadata || {},
    })
  );

/* ------------------------------------------------------------------ */
/* Legacy source mappings                                              */
/* ------------------------------------------------------------------ */

const legacySavings = (userId) =>
  Savings.find({
    userId,
    type: { $in: ["deposit", "withdrawal"] },
    category: { $ne: "minutes_payment" }, // minutes checkouts belong to MinuteTransaction
  }).lean();

const legacyMinutes = (userId) =>
  Savings.find({ userId, category: "minutes_payment" }).lean();

const legacyLoan = (userId) =>
  Savings.find({ userId, type: "loan_repayment" }).lean();

const legacyMembership = async (userId) => {
  const user = await User.findOne({ _id: userId, membershipFeePaid: true })
    .select("membershipFeeTxRef membershipFeePaidAt")
    .lean();
  if (!user) return [];
  return [
    {
      _id: `legacy_membership_${userId}`,
      reference: user.membershipFeeTxRef || `MEM-${userId}`,
      transactionId: user.membershipFeeTxRef || null,
      amount: MEMBERSHIP_FEE_AMOUNT,
      currency: "NGN",
      status: "completed",
      method: "flutterwave",
      paidAt: user.membershipFeePaidAt,
      createdAt: user.membershipFeePaidAt,
      metadata: {},
    },
  ];
};

const LEGACY = {
  savings: legacySavings,
  minute: legacyMinutes,
  membership: legacyMembership,
  loan: legacyLoan,
};

/* ------------------------------------------------------------------ */
/* Normalization + filtering                                           */
/* ------------------------------------------------------------------ */

const normalize = (type, row) => {
  const amount = Number(row.amount || 0);
  const isDebit = type === "savings" && row.type === "withdrawal";
  const labelMap = LABELS[type] || {};
  return {
    id: String(row._id || row.id || ""),
    type,
    category: row.type || type,
    label: labelMap[row.type] || labelMap.default || "Transaction",
    amount,
    // Withdrawal receipts need the processing fee + total deduction; zero
    // everywhere else. Legacy rows that never recorded a fee read as 0.
    fee: Number(row.fee || 0),
    penaltyFee: Number(row.penaltyFee || 0),
    totalDeducted:
      row.totalDeducted != null ? Number(row.totalDeducted) : null,
    // The member's own payout destination (savings withdrawals only).
    destinationBank: row.bankDetails
      ? {
          bankName: row.bankDetails.bankName || null,
          accountName: row.bankDetails.accountName || null,
          accountNumber: row.bankDetails.accountNumber || null,
        }
      : null,
    direction: isDebit ? "debit" : "credit",
    status: row.status || "completed",
    reference: row.reference || null,
    transactionId: row.transactionId || null,
    method: row.method || null,
    date: (row.paidAt || row.createdAt || new Date()).toISOString(),
    metadata: row.metadata || {},
  };
};

const buildDateRange = (month, year) => {
  const m = month ? parseInt(month, 10) : null;
  const y = year ? parseInt(year, 10) : null;
  if (!m && !y) return null;

  if (m && y) {
    return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
  }
  if (y) {
    return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
  }
  // Month-only filter uses the current year (explicit year preferred).
  const now = new Date();
  return { start: new Date(now.getFullYear(), m - 1, 1), end: new Date(now.getFullYear(), m, 1) };
};

const matchesDateRange = (row, range) => {
  if (!range) return true;
  const ts = new Date(row.paidAt || row.createdAt || 0).getTime();
  return ts >= range.start.getTime() && ts < range.end.getTime();
};

/**
 * De-duplicate merged transaction rows by reference.
 * Dedicated-model records are pushed first, so they win over legacy twins.
 */
const dedupeTransactions = (collected) => {
  const seen = new Set();
  const deduped = [];
  for (const tx of collected) {
    const key = tx.reference || `${tx.type}:${tx.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tx);
  }
  return deduped;
};

/**
 * Client-side (post-merge) search filter. The unified history is already an
 * in-memory merge, so searching here keeps parity between dedicated and
 * legacy rows without an extra index. Matches label, reference and
 * transactionId case-insensitively.
 */
const matchesSearch = (row, search) => {
  if (!search) return true;
  const q = String(search).trim().toLowerCase();
  if (!q) return true;
  return (
    String(row.label || "").toLowerCase().includes(q) ||
    String(row.reference || "").toLowerCase().includes(q) ||
    String(row.transactionId || "").toLowerCase().includes(q)
  );
};

/* ------------------------------------------------------------------ */
/* Unified list                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {number} [opts.month]  1-12
 * @param {number} [opts.year]   e.g. 2026
 * @param {string} [opts.type]   all | savings | minute | membership | loan
 * @param {string} [opts.search] free-text: label / reference / transactionId
 * @param {number} [opts.page]
 * @param {number} [opts.limit]  default 50, max 100
 */
const list = async ({ userId, month, year, type = "all", search, page = 1, limit = 50 }) => {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
    return { transactions: [], pagination: { total: 0, page: 1, limit: 50, totalPages: 0 } };
  }

  const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
  const range = buildDateRange(month, year);
  const types = type === "all" ? Object.keys(MODELS) : [type].filter(isValidType);

  const collected = [];

  for (const t of types) {
    // 1) Dedicated transaction model
    const rows = await MODELS[t].find({ userId }).lean();
    collected.push(...rows.filter((r) => matchesDateRange(r, range)).map((r) => normalize(t, r)));

    // 2) Legacy source (merged + de-duplicated below)
    const legacyRows = await LEGACY[t](userId);
    collected.push(
      ...legacyRows.filter((r) => matchesDateRange(r, range)).map((r) => normalize(t, r))
    );
  }

  // De-duplicate by reference — dedicated-model records are pushed first,
  // so they win over their legacy twins.
  const deduped = dedupeTransactions(collected).filter((r) => matchesSearch(r, search));

  deduped.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const total = deduped.length;
  const start = (normalizedPage - 1) * normalizedLimit;

  return {
    transactions: deduped.slice(start, start + normalizedLimit),
    pagination: {
      total,
      page: normalizedPage,
      limit: normalizedLimit,
      totalPages: Math.ceil(total / normalizedLimit),
    },
  };
};

/**
 * Fetch ONE transaction for a member across all sources.
 *
 * Used by the transaction-detail screen so a deep link / page refresh
 * resolves the record from the backend instead of trusting navigation
 * state. Scoped to the requesting user only — a foreign id is a plain
 * 404, never another member's record.
 *
 * @param {string} userId
 * @param {string} id  transaction document id
 * @returns {Promise<Object|null>} normalized transaction row (same shape as list())
 */
const getOne = async (userId, id) => {
  if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return null;
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;

  const oid = new mongoose.Types.ObjectId(String(id));

  // 1) Dedicated transaction models (same priority order as list()).
  for (const [type, Model] of Object.entries(MODELS)) {
    const row = await Model.findOne({ _id: oid, userId }).lean();
    if (row) return normalize(type, row);
  }

  // 2) Legacy sources (same merge rules as list(); normalize() makes the
  //    response shape identical whichever source matched).
  for (const [type, fetcher] of [
    ["savings", LEGACY.savings],
    ["minute", LEGACY.minute],
    ["loan", LEGACY.loan],
  ]) {
    const rows = await fetcher(userId);
    for (const row of rows) {
      if (String(row._id) === String(id)) return normalize(type, row);
    }
  }

  // 3) Legacy membership record (keyed off the user document, not an id we
  //    can match directly — it only resolves when the caller passes the
  //    synthetic `legacy_membership_<userId>` id used by list()).
  const membershipRows = await LEGACY.membership(userId);
  for (const row of membershipRows) {
    if (String(row._id) === String(id)) return normalize("membership", row);
  }

  return null;
};

module.exports = {
  list,
  getOne,
  recordSavingsTransaction,
  recordMinuteTransaction,
  recordMembershipTransaction,
  recordLoanTransaction,
  // Exposed for unit testing
  buildDateRange,
  normalize,
  dedupeTransactions,
  matchesSearch,
  MODELS,
};
