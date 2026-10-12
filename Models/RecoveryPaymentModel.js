const mongoose = require("mongoose");

const RecoveryPaymentSchema = new mongoose.Schema({
  obligationId: { type: mongoose.Schema.Types.ObjectId, ref: "RecoveryObligations", required: true, index: true },
  loanId: { type: mongoose.Schema.Types.ObjectId, ref: "Loans", required: true, index: true },
  borrowerId: { type: mongoose.Schema.Types.ObjectId, ref: "Users", required: true },
  guarantorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "Users", required: true, index: true },
  amount: { type: Number, required: true, min: 0.01 },
  reference: { type: String, required: true, unique: true, index: true },
  providerReference: { type: String, default: null, unique: true, sparse: true },
  status: { type: String, enum: ["pending", "completed", "failed", "reversed"], default: "pending", index: true },
  paidAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model("RecoveryPayments", RecoveryPaymentSchema);