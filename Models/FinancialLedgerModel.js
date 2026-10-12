const mongoose = require("mongoose");

const FinancialLedgerSchema = new mongoose.Schema(
  {
    entryType: {
      type: String,
      enum: ["inflow", "outflow"],
      required: true,
      index: true,
    },
    accountCategory: {
      type: String,
      enum: [
        "cash_asset",           // Cash in bank/vault
        "member_savings",       // Member savings liability
        "member_minutes",       // Member minutes contribution
        "membership_revenue",   // Membership fee revenue
        "loan_interest_revenue",// Loan interest revenue
        "withdrawal_fee_revenue",// Withdrawal service charge revenue
        "loan_principal_receivable", // Loan principal asset
        "operating_expense",    // Cooperative expenses
        "referral_expense",     // Referral rewards paid out
        "capital_equity",       // Starting capital / equity
        "recovery_repayment",   // Overdue recovery collected
      ],
      required: true,
      index: true,
    },
    activityType: {
      type: String,
      enum: [
        "savings_deposit",
        "membership_fee",
        "minutes_fee",
        "withdrawal_payout",
        "withdrawal_fee",
        "loan_disbursement",
        "loan_repayment_principal",
        "loan_repayment_interest",
        "operating_expense",
        "referral_reward",
        "guarantor_recovery_deduction",
        "starting_capital_injection",
        "reversal_adjustment",
      ],
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [0.01, "Ledger amount must be greater than 0"],
    },
    reference: {
      type: String,
      required: true,
      index: true,
    },
    eventKey: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      default: null,
      index: true,
    },
    relatedId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    relatedModel: {
      type: String,
      enum: ["Savings", "Loans", "Expenses", "Users", "Minutes", "Referrals", "RecoveryObligations", null],
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["posted", "reversed"],
      default: "posted",
      index: true,
    },
    reversedByLedgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FinancialLedger",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("FinancialLedger", FinancialLedgerSchema);
