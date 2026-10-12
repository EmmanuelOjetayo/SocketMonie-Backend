const mongoose = require("mongoose");

const InterestRuleSchema = new mongoose.Schema(
  {
    ruleName: {
      type: String,
      required: true,
      trim: true,
    },
    loanType: {
      type: String,
      enum: ["cooperative", "emergency", "personal", "business", "all"],
      default: "all",
      index: true,
    },
    tier: {
      type: String,
      enum: ["Bronze", "Silver", "Gold", "Platinum", "all"],
      default: "all",
      index: true,
    },
    minSocketScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    maxSocketScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 100,
    },
    interestRate: {
      type: Number,
      required: true,
      min: [0, "Interest rate cannot be negative"],
    },
    priority: {
      type: Number,
      default: 1, // Higher priority matched first
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    effectiveDate: {
      type: Date,
      default: Date.now,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("InterestRules", InterestRuleSchema);
