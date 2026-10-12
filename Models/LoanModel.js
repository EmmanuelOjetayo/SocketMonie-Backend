const mongoose = require("mongoose");
const crypto = require("crypto");

const InstallmentSchema = new mongoose.Schema({
  installmentNumber: {
    type: Number,
    required: true,
  },
  dueDate: {
    type: Date,
    required: true,
  },
  amountDue: {
    type: Number,
    required: true,
  },
  amountPaid: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ["unpaid", "partially_paid", "paid", "overdue"],
    default: "unpaid",
  },
  penaltyApplied: {
    type: Boolean,
    default: false,
  },
  paidAt: Date,
});

const LoanSchema = new mongoose.Schema(
  {
    // Borrower
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },

    // Loan Information
    loanType: {
      type: String,
      enum: ["cooperative", "emergency", "personal", "business"],
      default: "cooperative",
      index: true,
    },

    principalAmount: {
      type: Number,
      required: true,
    },

    interestRate: {
      type: Number,
      default: 5,
    },

    interestAmount: {
      type: Number,
      required: true,
    },

    disbursementAmount: {
      type: Number,
      default: 0,
    },

    totalRepayable: {
      type: Number,
      required: true,
    },

    durationMonths: {
      type: Number,
      required: true,
    },

    amountPaid: {
      type: Number,
      default: 0,
    },

    remainingBalance: {
      type: Number,
      required: true,
    },

    // Eligibility Snapshot & Tier
    tier: {
      type: String,
      default: "1st_tier_150",
    },

    socketScore: {
      type: Number,
      default: 0,
    },

    interestSnapshot: {
      rate: Number,
      amount: Number,
      ruleName: String,
      ruleVersion: String,
      calculatedAt: Date,
    },

    eligibilitySnapshot: {
      netSavings: Number,
      maxLoanAmount: Number,
      tier: String,
      isEmergency: Boolean,
    },

    // Loan Status
    status: {
      type: String,
      enum: [
        "waiting_guarantor",
        "pending_review",
        "active",
        "rejected",
        "completed",
        "warning_30_days",
        "defaulted_60_days",
        "restricted_90_days",
        "recovery_120_days",
      ],
      default: "waiting_guarantor",
      index: true,
    },

    rejectionReason: {
      type: String,
      default: null,
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },

    reviewedAt: Date,
    approvedAt: Date,

    loanNumber: {
      type: String,
      unique: true,
      index: true,
    },

    disbursedAt: Date,
    completedAt: Date,

    disbursementMethod: {
      type: String,
      enum: ["bank_transfer", "wallet"],
      default: "bank_transfer",
    },

    purpose: {
      type: String,
      default: "General",
    },

    // Legacy single guarantor support
    guarantor: {
      requestId: { type: mongoose.Schema.Types.ObjectId, ref: "Guarantors", default: null },
      guarantorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },
      fullName: String,
      email: String,
      phone: String,
      relationship: String,
      status: {
        type: String,
        enum: ["waiting_guarantor", "pending", "accepted", "rejected", "expired", "active", "released"],
        default: "pending",
      },
      acceptedAt: Date,
      guaranteedAmount: { type: Number, default: 0 },
      remainingGuaranteedBalance: { type: Number, default: 0 },
      guaranteeReleasedAt: Date,
    },

    // Active multi-guarantors
    guarantors: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "Users", required: true },
        fullName: String,
        email: String,
        phone: String,
        referralCode: String,
        status: {
          type: String,
          enum: ["pending", "accepted", "rejected", "expired", "active", "released"],
          default: "pending",
        },
        verificationToken: String,
        acceptedAt: Date,
        rejectedAt: Date,
        rejectionReason: String,
        isReplaced: { type: Boolean, default: false },
        replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },
        replacementReason: String,
        replacedAt: Date,
        guaranteedAmount: { type: Number, default: 0 },
        remainingGuaranteedBalance: { type: Number, default: 0 },
        requestedAt: { type: Date, default: Date.now },
      },
    ],

    recoveryStatus: {
      type: String,
      enum: ["none", "in_recovery", "recovered"],
      default: "none",
    },

    // Payment Summary
    nextPaymentDate: Date,
    nextPaymentAmount: { type: Number, default: 0 },
    missedPayments: { type: Number, default: 0 },
    installments: [InstallmentSchema],

    repaymentHistory: [
      {
        amount: Number,
        method: String,
        reference: String,
        transactionId: String,
        paidAt: Date,
      },
    ],

    payoutReference: { type: String, default: null },
    payoutStatus: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },
    payoutRef: { type: String, default: null },

    timeline: [
      {
        action: String,
        note: String,
        by: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

LoanSchema.virtual("progress").get(function () {
  if (!this.totalRepayable) return 0;
  return Math.round((this.amountPaid / this.totalRepayable) * 100);
});

LoanSchema.statics.generateLoanNumber = async function () {
  let loanNumber;
  do {
    loanNumber = `LN${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  } while (await this.exists({ loanNumber }));
  return loanNumber;
};

module.exports = mongoose.model("Loans", LoanSchema);