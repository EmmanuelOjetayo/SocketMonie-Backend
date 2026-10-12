const mongoose = require("mongoose");

const ComponentSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    weight: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    calculationRule: {
      type: String,
      enum: [
        "savings_consistency_6m",
        "savings_growth",
        "loan_repayment_timeliness",
        "withdrawal_behaviour",
        "profile_completion",
        "community_trust",
        "other_configured",
      ],
      default: "savings_consistency_6m",
    },
    formulaStatus: {
      type: String,
      enum: ["assumption", "approved", "unconfigured"],
      default: "assumption",
    },
    normalizationConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    description: {
      type: String,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const ScoreConfigSchema = new mongoose.Schema(
  {
    version: {
      type: Number,
      required: true,
      unique: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    components: {
      type: [ComponentSchema],
      required: true,
      validate: [
        (val) => {
          if (!Array.isArray(val) || val.length === 0) return false;
          const active = val.filter((c) => c.isActive !== false);
          const total = active.reduce((acc, curr) => acc + (curr.weight || 0), 0);
          return Math.abs(total - 100) < 0.001;
        },
        "Total active component weights must equal exactly 100%",
      ],
    },
    totalWeight: {
      type: Number,
      required: true,
      default: 100,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },
    changeNotes: {
      type: String,
      default: "Initial scoring configuration",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ScoreConfigs", ScoreConfigSchema);
