const Loan = require("../Models/LoanModel");
const LoanTransaction = require("../Models/LoanTransactionModel");
const Savings = require("../Models/SavingsModel");
const User = require("../Models/UserModel");
const Guarantor = require("../Models/GuarantorModel");
const SystemSettings = require("../Models/SystemSettingsModel");

// Legacy SocketMinutes checkout rows were also written to Savings. They are
// never eligible savings/deposit evidence for loan calculations.
const SAVINGS_LEDGER_SCOPE = {
  type: { $in: ["deposit", "withdrawal"] },
  category: { $ne: "minutes_payment" },
};

const LoanRepository = {
  findById: (loanId, session = null) => {
    const query = Loan.findById(loanId);
    if (session) query.session(session);
    return query;
  },

  findOne: (filter, session = null) => {
    const query = Loan.findOne(filter);
    if (session) query.session(session);
    return query;
  },

  findActiveForUser: (userId, session = null) => {
    const query = Loan.findOne({
      userId,
      status: {
        $in: [
          "waiting_guarantor",
          "pending_review",
          "active",
          "warning_30_days",
          "defaulted_60_days",
          "restricted_90_days",
          "recovery_120_days",
        ],
      },
    });
    if (session) query.session(session);
    return query;
  },

  // Serialization anchor for concurrent financial operations: touching the
  // member document inside a MongoDB transaction creates a write conflict when
  // two transactions touch the same member, forcing MongoDB to serialize them
  // and retry — the retry re-runs the active-loan re-check inside the transaction.
  touchMemberForApplicationLock: (userId, session = null) => {
    const query = User.findOneAndUpdate(
      { _id: userId },
      { $set: { updatedAt: new Date() } },
      { new: true }
    );
    if (session) query.session(session);
    return query;
  },

  findHistory: (filter, skip, limit) =>
    Loan.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),

  count: (filter) => Loan.countDocuments(filter),

  findCompletedSavings: (userId) =>
    Savings.find({ userId, status: "completed", ...SAVINGS_LEDGER_SCOPE }),

  findCompletedDeposits: (userId) =>
    Savings.find({
      userId,
      status: "completed",
      ...SAVINGS_LEDGER_SCOPE,
      type: "deposit",
    }).sort({ createdAt: 1 }),

  findSettings: () => SystemSettings.findOne(),

  createSettings: (settings) => SystemSettings.create(settings),

  findUserById: (userId) => User.findById(userId),

  findUserByReferralCode: (referralCode) => User.findOne({ referralCode }),

  findActiveGuaranteeForGuarantor: (guarantorId, activeStatuses) =>
    Loan.findOne({
      "guarantors.userId": guarantorId,
      "guarantors.isReplaced": false,
      status: { $in: activeStatuses },
    }),

  generateLoanNumber: () => Loan.generateLoanNumber(),

  createLoanWithGuarantors: async (loanData, guarantorsData, session) => {
    const [createdLoan] = await Loan.create([loanData], { session });
    const formattedGuarantors = guarantorsData.map((g) => ({
      ...g,
      loanId: createdLoan._id,
    }));
    await Guarantor.insertMany(formattedGuarantors, { session });
    return createdLoan;
  },

  saveLoan: (loan, session = null) => {
    if (session) return loan.save({ session });
    return loan.save();
  },

  updateById: (loanId, update, session = null) => {
    const options = { new: true };
    if (session) options.session = session;
    return Loan.findByIdAndUpdate(loanId, update, options);
  },

  findGuarantorDocument: (filter, session = null) => {
    const query = Guarantor.findOne(filter);
    if (session) query.session(session);
    return query;
  },

  createGuarantorDocument: (data, session = null) => {
    if (session) {
      return Guarantor.create([data], { session }).then((docs) => docs[0]);
    }
    return Guarantor.create(data);
  },

  saveGuarantor: (guarantor, session = null) => {
    if (session) return guarantor.save({ session });
    return guarantor.save();
  },

  // Close standalone guarantor requests that are still pending on a loan that
  // has just been withdrawn, so they drop off guarantors' pending lists.
  expirePendingGuarantorRequests: (loanId, session = null) => {
    const query = Guarantor.updateMany(
      { loanId, status: "pending", isReplaced: false },
      { $set: { status: "expired" } }
    );
    if (session) query.session(session);
    return query;
  },

  // Loan repayments use LoanTransaction, not Savings. These method names are
  // retained for call-site stability but now target the dedicated model.
  findSavings: (filter, session = null) => {
    const query = LoanTransaction.findOne(filter);
    if (session) query.session(session);
    return query;
  },

  createSavingsRecord: (data, session = null) => {
    if (session) {
      return LoanTransaction.create([data], { session }).then((docs) => docs[0]);
    }
    return LoanTransaction.create(data);
  },

  updateSavings: (filter, update, session = null) => {
    const options = { new: true };
    if (session) options.session = session;
    return LoanTransaction.updateOne(filter, update, options);
  },
};

module.exports = { LoanRepository };