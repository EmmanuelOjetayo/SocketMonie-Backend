const Savings = require("../Models/SavingsModel");
const User = require("../Models/UserModel");
const Loan = require("../Models/LoanModel");
const Minutes = require("../Models/MinutesModel");

const PaymentRepository = {
  findUser: (userId) => User.findById(userId),

  findSavingsByReference: (reference) => Savings.findOne({ reference }),

  isTransactionProcessed: async (providerRef, model = "savings", refField = "flutterwaveRef") => {
    if (!providerRef) return false;
    const targetModel = model === "loan" ? Loan : model === "minutes" ? Minutes : Savings;
    const existing = await targetModel.findOne({ [refField]: String(providerRef), status: "completed" });
    return !!existing;
  },

  createPendingDeposit: (data) => Savings.create(data),

  findAndCompleteDeposit: (reference, updateData, session = null) =>
    Savings.findOneAndUpdate(
      { reference, status: "pending" },
      { $set: updateData },
      { new: true, ...(session ? { session } : {}) }
    ),

  findWithdrawalByReference: (reference, session = null) => {
    const query = Savings.findOne({ reference, type: "withdrawal", status: "pending" });
    if (session) query.session(session);
    return query;
  },

  findLoanByPayoutReference: (reference) => Loan.findOne({ payoutReference: reference }),

  findRepaymentByReference: (reference) =>
    Savings.findOne({ reference, type: "loan_repayment", status: "pending" }),

  findUserByMembershipRef: (reference) => User.findOne({ membershipFeeTxRef: reference }),

  findMinutesByReference: (reference) => Minutes.findOne({ reference }),

  findAndCompleteMinutes: (reference, updateData, session = null) =>
    Minutes.findOneAndUpdate(
      { reference, status: "pending" },
      { $set: updateData },
      { new: true, ...(session ? { session } : {}) }
    ),

  markCompleted: (model, id, providerRef, additionalData = {}, session = null) => {
    const targetModel = model === "loan" ? Loan : model === "minutes" ? Minutes : Savings;
    return targetModel.findByIdAndUpdate(id, {
      status: "completed",
      flutterwaveRef: String(providerRef),
      ...additionalData,
    }, session ? { session, new: true } : { new: true });
  },

  updateUser: (userId, updateData) => User.findByIdAndUpdate(userId, updateData, { new: true }),
};

module.exports = { PaymentRepository };