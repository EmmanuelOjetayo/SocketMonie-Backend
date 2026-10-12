const mongoose = require("mongoose");

const AdminActivitySchema = new mongoose.Schema({
  // Admin who performed the action
  adminId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Users",
    required: true,
  },
  // Type of action
  action: {
    type: String,
    required: true,
    enum: [
      "expense_create",
      "expense_reverse",
      "capital_add",
      "capital_deduct",
      "revenue_add",
      "loan_approve",
      "loan_reject",
      "member_suspend",
      "member_activate",
      "setting_update",
    ],
  },
  // Details of the action
  details: {
    type: String,
    default: "",
  },
  // Reference to related entity
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },
  // Reference type (expense, loan, capital, member, setting)
  referenceType: {
    type: String,
    default: "",
  },
  // IP address and user agent for audit
  ipAddress: {
    type: String,
    default: "",
  },
  userAgent: {
    type: String,
    default: "",
  },
  // Timestamp
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("AdminActivity", AdminActivitySchema);