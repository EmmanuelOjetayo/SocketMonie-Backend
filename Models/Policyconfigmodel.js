const mongoose = require("mongoose");

const TierSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      enum: ["Bronze", "Silver", "Gold", "Platinum"],
      required: true,
    },
    minMonthlySavings: { type: Number, required: true },
    maxMonthlySavings: { type: Number, default: null }, // null = no upper bound (Platinum)
    interestRate: { type: Number, required: true }, // percentage, e.g. 10 for 10%
    requiredDocuments: {
      type: [String], // e.g. ["passport", "nin", "bvn", "drivers_license_or_voters_card"]
      default: [],
    },
  },
  { _id: false }
);

const PolicyConfigSchema = new mongoose.Schema(
  {
    // Singleton flag — there should only ever be one PolicyConfig document
    singleton: { type: Boolean, default: true, unique: true },

    tiers: {
      type: [TierSchema],
      default: [
        {
          name: "Bronze",
          minMonthlySavings: 5000,
          maxMonthlySavings: 20000,
          interestRate: 10,
          requiredDocuments: ["passport", "nin"],
        },
        {
          name: "Silver",
          minMonthlySavings: 21000,
          maxMonthlySavings: 50000,
          interestRate: 8,
          requiredDocuments: ["passport", "nin"],
        },
        {
          name: "Gold",
          minMonthlySavings: 51000,
          maxMonthlySavings: 100000,
          interestRate: 6,
          requiredDocuments: ["passport", "nin", "bvn"],
        },
        {
          name: "Platinum",
          minMonthlySavings: 100000,
          maxMonthlySavings: null,
          interestRate: 5,
          requiredDocuments: ["passport", "nin", "bvn", "drivers_license_or_voters_card"],
        },
      ],
    },

    // Loan borrowing-limit tiers, keyed by number of previously completed loans
    loanTierPercentages: {
      tier1_first_loan: { type: Number, default: 70 }, // 70%
      tier2_second_loan: { type: Number, default: 100 }, // 100%
      tier3_third_loan_plus: { type: Number, default: 150 }, // 150%
    },

    // Loans requesting more than this % of net savings require a guarantor
    guarantorRequiredAbovePercentage: { type: Number, default: 150 },

    savingsConsistencyMonthsRequired: { type: Number, default: 6 },
    minNetSavingsForLoanEligibility: { type: Number, default: 70000 },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PolicyConfig", PolicyConfigSchema);