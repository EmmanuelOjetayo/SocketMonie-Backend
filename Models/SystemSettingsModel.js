const mongoose = require("mongoose");

const SystemSettingsSchema = new mongoose.Schema(
  {
    loanTiers: {
      firstLoan: { type: Number, default: 1.5 }, // 150%
      secondLoan: { type: Number, default: 2.0 }, // 200%
      emergencyLoan: { type: Number, default: 0.75 }, // 75%
      thirdLoan: { type: Number, default: 2.0 }, // 200%
    },
    interestRates: {
      bronze: { type: Number, default: 10 },
      silver: { type: Number, default: 8 },
      gold: { type: Number, default: 6 },
      platinum: { type: Number, default: 5 },
      emergency: { type: Number, default: 5 },
    },
    eligibility: {
      minSavings: { type: Number, default: 70000 },
      minMonths: { type: Number, default: 6 },
      guarantorMinSavings: { type: Number, default: 70000 },
      guarantorPercentageRequired: { type: Number, default: 25 }, // > 25%
    },
    withdrawalFee: { type: Number, default: 100 },
    latePenaltyRate: { type: Number, default: 2 },
    referralReward: {
      referrerAmount: { type: Number, default: 500 },
      referredUserAmount: { type: Number, default: 0 },
      qualificationEvent: { type: String, default: "membership_fee_paid" },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SystemSettings", SystemSettingsSchema);