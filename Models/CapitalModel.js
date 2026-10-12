const mongoose = require("mongoose");

const CapitalSchema = new mongoose.Schema({
  // Capital source (e.g., "initial_capital", "interest_revenue", "withdrawal_fee", "loan_principal_repayment")
  source: {
    type: String,
    required: true,
  },
  // Description of the capital movement
  description: {
    type: String,
    default: "",
  },
  // Amount added or removed (positive = added, negative = deducted)
  amount: {
    type: Number,
    required: true,
  },
  // Related entity (e.g., expenseId, loanId, userId)
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  // Reference type (expense, loan, user, etc.)
  referenceType: {
    type: String,
    default: "",
  },
  // Admin who performed the action
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Users",
    required: true,
  },
  // Timestamp
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Capital", CapitalSchema);