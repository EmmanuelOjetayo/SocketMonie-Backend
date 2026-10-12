const mongoose = require("mongoose");

const MinutesSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },

    amount: {
      type: Number,
      required: true,
      default: 500,
    },

    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },

    year: {
      type: Number,
      required: true,
    },

    type: {
      type: String,
      enum: ["deposit"],
      default: "deposit",
    },

    category: {
      type: String,
      enum: ["monthly_contribution"],
      default: "monthly_contribution",
    },

    reference: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    transactionId: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: [
        "pending",
        "completed",
        "failed",
        "overdue",
      ],
      default: "pending",
      index: true,
    },

    paidAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

/*
 * One SocketMinutes obligation per member per month.
 *
 * Example:
 * User A + August 2026 = only one record.
 */
MinutesSchema.index(
  { userId: 1, month: 1, year: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "Minutes",
  MinutesSchema
);