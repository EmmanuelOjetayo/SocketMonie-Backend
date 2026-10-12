const mongoose = require("mongoose");

const RecoveryObligationSchema = new mongoose.Schema(
  {
    loanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Loans",
      required: true,
      index: true,
    },
    borrowerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    guarantorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    guarantorName: {
      type: String,
      required: true,
    },
    originalGuaranteedAmount: {
      type: Number,
      required: true,
    },
    totalAssignedRecovery: {
      type: Number,
      required: true,
    },
    amountRecovered: {
      type: Number,
      default: 0,
    },
    remainingRecoveryBalance: {
      type: Number,
      required: true,
    },
    monthlyRecoveryAmount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "active", "partially_paid", "completed", "cancelled", "defaulted"],
      default: "active",
      index: true,
    },
    deductions: [
      {
        amount: Number,
        paidAt: { type: Date, default: Date.now },
        reference: String,
        installmentNumber: Number,
      },
    ],
    paymentReferences: [{ type: String, unique: true, sparse: true }],
    lastDeductionAt: Date,
    completedAt: Date,
  },
  { timestamps: true }
);

RecoveryObligationSchema.index({ loanId: 1, guarantorUserId: 1 }, { unique: true });

module.exports = mongoose.model("RecoveryObligations", RecoveryObligationSchema);
