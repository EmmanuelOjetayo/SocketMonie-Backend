const mongoose = require("mongoose");

/**
 * SavingsTransaction — dedicated transaction record for savings activity.
 *
 * Mirrors the money movement already recorded in the Savings collection
 * (deposits / withdrawals) but lives in its own model so transaction
 * history can be queried, filtered and displayed independently of the
 * savings ledger. Written additively at settlement points; existing
 * Savings records remain the system of record for balances.
 */
const SavingsTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["deposit", "withdrawal"],
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
    fee: { type: Number, default: 0 },
    currency: { type: String, default: "NGN" },
    status: {
      type: String,
      enum: ["completed", "pending", "failed", "pending_approval", "approved", "rejected"],
      default: "completed",
    },
    method: { type: String, default: "flutterwave" },
    paidAt: { type: Date, default: null },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SavingsTransaction", SavingsTransactionSchema);
