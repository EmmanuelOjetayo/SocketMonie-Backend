const mongoose = require("mongoose");

const savingsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [100, "Minimum savings amount is 100"],
    },
    type: {
      type: String,
      enum: ["deposit", "withdrawal", "loan_repayment"],
      default: "deposit",
    },
    method: {
      type: String,
      enum: ["bank_transfer", "card", "wallet", "flutterwave", "Bank Transfer", "Card", "Wallet"],
      default: "Bank Transfer",
    },
    status: {
      type: String,
      enum: ["completed", "pending", "failed", "pending_approval", "approved", "rejected"],
      default: "pending",
    },
    monthlyTarget: {
      type: Number,
      default: 5000,
    },
    fee: { type: Number, default: 0 },
    penaltyFee: { type: Number, default: 0 }, // Track 10% early withdrawal penalty separately
    lockPeriodDays: { type: Number, default: 30 }, // Default 30-day lock period
    maturityDate: { type: Date, default: null },
    isLocked: { type: Boolean, default: true },
    
    reference: { type: String, default: null },
    flutterwaveRef: { type: String, default: null },

    // For withdrawal requests
    bankDetails: {
      bankCode: { type: String, default: null },
      bankName: { type: String, default: null },
      accountNumber: { type: String, default: null },
      accountName: { type: String, default: null },
    },
    // For loan repayments
    loanId: { type: mongoose.Schema.Types.ObjectId, ref: "Loans", default: null },

    rejectionReason: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const Savings = mongoose.model("Savings", savingsSchema);
module.exports = Savings;