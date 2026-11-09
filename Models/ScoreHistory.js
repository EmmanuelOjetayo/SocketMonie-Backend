const mongoose = require("mongoose");

/**
 * ScoreHistory — one record per member per calendar month.
 *
 * CGPA-inspired model:
 *  - `monthlyScore`    performance in that single calendar month (0-100)
 *  - `cumulativeScore` weighted average of all FINAL months up to and
 *                      including this month (can rise or fall as months are added)
 *  - Monthly records are preserved forever; new weights only affect NEW
 *    calculations and only rewrite history when an authorised recalculation
 *    runs. Nothing here is ever reset to zero at month rollover.
 *
 * Backward compatibility: `overallScore` is kept and mirrors `monthlyScore`
 * for readers built on the old shape. Legacy records migrated from the old
 * schema will lack the new fields — every new field has a safe default.
 */
const ScoreHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    // Legacy field — mirrors monthlyScore. Do NOT use for cumulative readings.
    overallScore: { type: Number, required: true, min: 0, max: 100 },
    monthlyScore: { type: Number, min: 0, max: 100, default: null },
    cumulativeScore: { type: Number, min: 0, max: 100, default: 0 },
    creditWeight: { type: Number, default: 1, min: 0 }, // 1 per month (CGPA equal credit)
    eligibleWeight: { type: Number, default: 100, min: 0 }, // Σ weights of eligible components
    calculationStatus: {
      type: String,
      enum: ["final", "provisional", "superseded"],
      default: "final",
      index: true,
    },
    breakdown: {
      savingsConsistency: { type: Number, default: 0 },
      savingsGrowth: { type: Number, default: 0 },
      loanRepayment: { type: Number, default: 0 },
      withdrawalBehaviour: { type: Number, default: 0 },
      profileCompletion: { type: Number, default: 0 },
      communityTrust: { type: Number, default: 0 },
    },
    components: [
      {
        code: { type: String, required: true },
        name: { type: String, required: true },
        rawScore: { type: Number, min: 0, max: 100, default: null }, // null = ineligible
        weight: { type: Number, min: 0, max: 100, required: true },
        contribution: { type: Number, min: 0, max: 100, default: 0 },
        status: { type: String, default: "configured" },
        eligible: { type: Boolean, default: true },
        applicableMaximum: { type: Number, default: null },
      },
    ],
    configurationVersion: { type: Number, required: true },
    calculatedAt: { type: Date, required: true, default: Date.now },
    recalculatedAt: { type: Date, default: null },
    recalculatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },
    recalculatedReason: { type: String, default: null },
    sourceRefs: { type: [String], default: [] }, // tx ids / references used
    period: {
      year: { type: Number, required: true },
      month: { type: Number, required: true, min: 1, max: 12 },
    },
    trigger: { type: String, default: null },
  },
  { timestamps: true }
);

// One score record per member per calendar month — idempotent upserts only.
ScoreHistorySchema.index({ userId: 1, "period.year": 1, "period.month": 1 }, { unique: true });
ScoreHistorySchema.index({ userId: 1, calculatedAt: -1 });

ScoreHistorySchema.statics.getScoringWeights = function () {
  // Current approved weights. The authoritative, admin-configurable version
  // lives in ScoreConfig — this static is only a reporting fallback.
  return {
    savings_consistency: 35,
    savings_growth: 15,
    loan_repayment: 20,
    withdrawal_behaviour: 10,
    profile_completion: 5,
    community_trust: 15,
  };
};

module.exports = mongoose.model("ScoreHistory", ScoreHistorySchema);
