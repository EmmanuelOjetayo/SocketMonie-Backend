const mongoose = require("mongoose");

const SystemSettingsSchema = new mongoose.Schema({
  loanTiers: {
    firstLoan: { type: Number, default: 0.7 },
    secondLoan: { type: Number, default: 1.0 },
    thirdLoan: { type: Number, default: 1.5 },
  },
  interestRates: {
    bronze: { type: Number, default: 10 },
    silver: { type: Number, default: 8 },
    gold: { type: Number, default: 6 },
    platinum: { type: Number, default: 5 },
  },
  eligibility: {
    minSavings: { type: Number, default: 70000 },
    minMonths: { type: Number, default: 6 },
  },
  withdrawalFee: { type: Number, default: 100 },
  latePenaltyRate: { type: Number, default: 2 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model("SystemSettings", SystemSettingsSchema);