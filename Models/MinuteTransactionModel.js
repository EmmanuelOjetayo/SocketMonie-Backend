const mongoose = require("mongoose");

/**
 * MinuteTransaction — dedicated transaction record for SocketMinutes
 * contribution payments.
 *
 * One record per checkout payment (the money movement), distinct from the
 * monthly obligation ledger in the Minutes collection. Written additively
 * at settlement points; the Minutes collection remains the system of
 * record for monthly obligations.
 */
const MinuteTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["minute_contribution"],
      default: "minute_contribution",
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
    metadata: {
      type: Object,
      default: {},
      // e.g. { months: [{ month, year, amount }], monthsCount, contributionAmount, fee }
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MinuteTransaction", MinuteTransactionSchema);
