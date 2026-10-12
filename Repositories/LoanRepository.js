const Loan = require("../Models/LoanModel");
const Savings = require("../Models/SavingsModel");
const User = require("../Models/UserModel");
const Guarantor = require("../Models/GuarantorModel");
const SystemSettings = require("../Models/SystemSettingsModel");

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

  findActiveForUser: (userId) =>
    Loan.findOne({
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
    }),

  findHistory: (filter, skip, limit) =>
    Loan.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),

  count: (filter) => Loan.countDocuments(filter),

  findCompletedSavings: (userId) => Savings.find({ userId, status: "completed" }),

  findCompletedDeposits: (userId) =>
    Savings.find({
      userId,
      type: "deposit",
      status: "completed",
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

  findSavings: (filter, session = null) => {
    const query = Savings.findOne(filter);
    if (session) query.session(session);
    return query;
  },

  createSavingsRecord: (data, session = null) => {
    if (session) {
      return Savings.create([data], { session }).then((docs) => docs[0]);
    }
    return Savings.create(data);
  },

  updateSavings: (filter, update, session = null) => {
    const options = { new: true };
    if (session) options.session = session;
    return Savings.updateOne(filter, update, options);
  },
};

module.exports = { LoanRepository };