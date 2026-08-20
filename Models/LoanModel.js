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
  enum: [
    "unpaid",
    "partially_paid",
    "paid",
    "overdue",
  ],
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
      index: true
    },

    // Loan Information
    loanType: {
      type: String,
      enum: [
        "cooperative",
        "emergency",
        "personal",
        "business",
      ],
      default: "cooperative",
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

    totalRepayable: {
      type: Number,
      required: true,
    },

    durationMonths: {
      type: Number,
      required: true,
      enum: [1, 3, 6, 12],
    },

    amountPaid: {
      type: Number,
      default: 0,
    },

    remainingBalance: {
      type: Number,
      required: true,
    },

    // Eligibility Snapshot
    tier: {
      type: String,
      enum: [
        "1st_tier_70",
        "2nd_tier_100",
        "3rd_tier_150",
      ],
      required: true,
    },

    socketScore: {
      type: Number,
      default: 0,
    },

    eligibilitySnapshot: {
      netSavings: Number,
      maxLoanAmount: Number,
      tier: String,
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
      default: "pending_review",
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
},

    disbursedAt: Date,

    completedAt: Date,

    // Loan Configuration
    disbursementMethod: {
      type: String,
      enum: [
        "bank_transfer",
        "wallet",
      ],
      default: "bank_transfer",
    },

    purpose: {
      type: String,
      default: "General",
    },

    // ===============================
// Guarantor Snapshot
// ===============================

guarantor: {
  requestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Guarantors",
    default: null,
  },

  guarantorUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Users",
    default: null,
  },

  fullName: String,

  email: String,

  phone: String,

  relationship: String,

  status: {
    type: String,
    enum: [
      "waiting_guarantor",
      "pending",
      "accepted",
      "rejected",
      "expired",
    ],
    default: "pending",
  },

  acceptedAt: Date,

  guaranteedAmount: {
    type: Number,
    default: 0,
  },

  remainingGuaranteedBalance: {
    type: Number,
    default: 0,
  },

  guaranteeReleasedAt: Date,
},

    guarantors: [{
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "Users", required: true },
      fullName: String,
      email: String,
      phone: String,
      referralCode: String,
      status: {
        type: String,
        enum: ["pending", "accepted", "rejected", "expired", "active"],
        default: "pending",
      },
      verificationToken: String,
      acceptedAt: Date,
      guaranteedAmount: { type: Number, default: 0 },
      remainingGuaranteedBalance: { type: Number, default: 0 },
      requestedAt: { type: Date, default: Date.now },
    }],

    // Payment Summary
    nextPaymentDate: Date,

    nextPaymentAmount: {
      type: Number,
      default: 0,
    },

    missedPayments: {
      type: Number,
      default: 0,
    },

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

    // Flutterwave Payout
    payoutReference: {
      type: String,
      default: null,
    },

    payoutStatus: {
      type: String,
      enum: [
        "pending",
        "completed",
        "failed",
      ],
      default: "pending",
    },

    payoutRef: {
      type: String,
      default: null,
    },

    // Timeline
    timeline: [
      {
        action: String,

        note: String,

        by: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Users",
        },

        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Virtual Progress Percentage
LoanSchema.virtual("progress").get(function () {
  if (!this.totalRepayable) return 0;

  return Math.round(
    (this.amountPaid / this.totalRepayable) * 100
  );
});

LoanSchema.statics.generateLoanNumber = async function () {
  let loanNumber;

  do {
    loanNumber = `LN${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  } while (await this.exists({ loanNumber }));

  return loanNumber;
};

module.exports = mongoose.model("Loans", LoanSchema);