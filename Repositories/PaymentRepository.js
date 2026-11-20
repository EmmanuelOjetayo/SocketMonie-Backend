const Savings = require("../Models/SavingsModel");
const User = require("../Models/UserModel");
const Loan = require("../Models/LoanModel");
const Minutes = require("../Models/MinutesModel");
const LoanTransaction = require("../Models/LoanTransactionModel");
const MinuteTransaction = require("../Models/MinuteTransactionModel");
const MembershipTransaction = require("../Models/MembershipTransactionModel");

// Savings is the system of record for savings deposits/withdrawals ONLY.
// Legacy SocketMinutes checkout rows were written here with
// `category: "minutes_payment"`; they are deliberately excluded so they can
// never leak into savings balances, reports or history.
const SAVINGS_SCOPE = { type: "deposit", category: { $ne: "minutes_payment" } };

const PaymentRepository = {
  findUser: (userId) => User.findById(userId),

  findSavingsByReference: (reference) => Savings.findOne({ reference, ...SAVINGS_SCOPE }),

  isTransactionProcessed: async (providerRef, model = "savings") => {
    if (!providerRef) return false;
    const providerId = String(providerRef);
    if (model === "minutes") {
      return !!(await MinuteTransaction.findOne({
        $or: [{ transactionId: providerId }, { "metadata.providerTransactionId": providerId }],
        status: "completed",
      }));
    }
    if (model === "membership") {
      return !!(await MembershipTransaction.findOne({
        $or: [{ transactionId: providerId }, { "metadata.providerTransactionId": providerId }],
        status: "completed",
      }));
    }
    if (model === "loan") {
      return !!(await LoanTransaction.findOne({
        $or: [{ transactionId: providerId }, { "metadata.providerTransactionId": providerId }],
        status: "completed",
      }));
    }
    return !!(await Savings.findOne({
      ...SAVINGS_SCOPE,
      $or: [{ transactionId: providerId }, { flutterwaveRef: providerId }],
      status: "completed",
    }));
  },

  createPendingDeposit: (data) => Savings.create(data),

  findAndCompleteDeposit: (reference, updateData, session = null) =>
    Savings.findOneAndUpdate(
      // Never let the deposit settlement path complete a Socket Minutes checkout
      // or a loan repayment checkout record.
      { reference, status: "pending", ...SAVINGS_SCOPE },
      { $set: updateData },
      { new: true, ...(session ? { session } : {}) }
    ),

  findWithdrawalByReference: (reference, session = null) => {
    // A payout event may only settle an ADMIN-APPROVED withdrawal that is
    // still awaiting payout confirmation ("approved"). The previous filter
    // ("pending") could never match a withdrawal record — withdrawals live in
    // pending_approval / approved / completed / failed / rejected — so payout
    // webhooks were silently dropped and the withdrawal never settled.
    // Matching "approved" also keeps the business rule intact: a payout
    // event can never settle a request that no admin approved.
    const query = Savings.findOne({ reference, type: "withdrawal", status: "approved" });
    if (session) query.session(session);
    return query;
  },

  findLoanByPayoutReference: (reference) => Loan.findOne({ payoutReference: reference }),

  // Each payment category resolves through its own dedicated transaction model.
  findRepaymentByReference: (reference) =>
    LoanTransaction.findOne({ reference, type: "loan_repayment" }),

  findMinutesCheckoutByReference: (reference) =>
    MinuteTransaction.findOne({ reference, type: "minute_contribution" }),

  findMembershipTransactionByReference: (reference) =>
    MembershipTransaction.findOne({ reference, type: "membership_fee" }),

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