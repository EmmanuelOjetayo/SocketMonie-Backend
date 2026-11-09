const mongoose = require("mongoose");

/**
 * LoanTransaction — dedicated transaction record for loan activity.
 *
 * Covers repayments (money in) and disbursements/payouts (money out).
 * Repayments already exist in the LoanRepayment collection and as Savings
 * records (type: "loan_repayment"); this model gives them a single,
 * queryable transaction history entry. Written additively at settlement
 * points.
 */
const LoanTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    loanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Loans",
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: ["loan_repayment", "loan_disbursement"],
      required: true,
    },
    reference: {
      type: String,
      required: true,
      unique: true,
      sparse: true,
      index: true,
    },
    transactionId: { type: String, default: null },
    amount: { type: Number, required: true },
    currency: { type: String, default: "NGN" },
    status: {
      type: String,
      enum: ["completed", "pending", "failed"],
      default: "completed",
    },
    method: { type: String, default: "flutterwave" },
    paidAt: { type: Date, default: null },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LoanTransaction", LoanTransactionSchema);
