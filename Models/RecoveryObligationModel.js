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
    // Recovery-cycle tracking (calculated infrastructure; no auto deduction execution)
    currentCycleObligation: { type: Number, default: 0 },
    currentCycleShare: { type: Number, default: 0 },
    currentCycleOverdueAmount: { type: Number, default: 0 },
    currentCycleCurrentMonthAmount: { type: Number, default: 0 },
    deductionExecutionStatus: {
      type: String,
      enum: ["not_enabled", "pending", "partial", "completed", "failed"],
      default: "not_enabled",
    },
    lastCalculatedAt: { type: Date, default: null },
    deductions: [
      {
        amount: Number,
        status: { type: String, enum: ["pending", "completed", "failed", "partial"], default: "pending" },
        paidAt: { type: Date, default: null },
        attemptedAt: { type: Date, default: null },
        reference: String,
        providerReference: String,
        installmentNumber: Number,
        failureReason: String,
        scorePenaltyApplied: { type: Boolean, default: false },
        scoreResult: { type: Number, default: null },
      },
    ],
    paymentReferences: [{ type: String, unique: true, sparse: true }],
    lastDeductionAt: Date,
    consentGivenAt: Date,
    consentEvidence: String,
    providerReference: String,
    mandateStatus: {
      type: String,
      enum: ["not_provided", "pending", "authorized", "completed", "revoked"],
      default: "not_provided",
    },
    completedAt: Date,
  },
  { timestamps: true }
);

RecoveryObligationSchema.index({ loanId: 1, guarantorUserId: 1 }, { unique: true });

module.exports = mongoose.model("RecoveryObligations", RecoveryObligationSchema);
