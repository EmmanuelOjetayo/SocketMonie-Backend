const mongoose = require("mongoose");

/**
 * MembershipTransaction — dedicated transaction record for membership fee
 * payments.
 *
 * Membership payments previously lived only as flags on the User document
 * (membershipFeePaid / membershipFeeTxRef / membershipFeePaidAt) with no
 * transaction record. This model gives them a proper, queryable history
 * entry. Written additively at settlement points.
 */
const MembershipTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["membership_fee"],
      default: "membership_fee",
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

module.exports = mongoose.model("MembershipTransaction", MembershipTransactionSchema);
