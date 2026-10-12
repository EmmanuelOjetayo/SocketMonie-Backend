const mongoose = require("mongoose");

const ExpenseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [0.01, "Amount must be greater than 0"],
    },
    category: {
      type: String,
      enum: [
        "office_supplies",
        "salaries",
        "utilities",
        "marketing",
        "legal_compliance",
        "technology",
        "referral_payout",
        "miscellaneous",
      ],
      required: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    reference: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },
    expenseDate: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ["active", "reversed", "voided"],
      default: "active",
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
    },
    reversedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },
    reversalReason: {
      type: String,
      default: null,
    },
    reversedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Expenses", ExpenseSchema);
