/**
 * Centralized configuration constants for SocketMonnie backend.
 * These values were previously hardcoded across multiple services.
 */

// Guarantor eligibility requirements
const GUARANTOR_MIN_SAVINGS = 70000;
const GUARANTOR_MIN_PERCENTAGE = 0.25;

// Payment-related constants
const MONTHLY_MINUTES_AMOUNT = 500;
const MEMBERSHIP_FEE_AMOUNT = 1000;
const WITHDRAWAL_FEE = 100;

// Loan-related constants
const LATE_PENALTY_RATE = 2;
const MIN_MONTHLY_SAVINGS = 5000;

// Loan tier multipliers (as percentage of net savings)
const LOAN_TIERS = {
  firstLoan: 1.5,
  secondLoan: 2.0,
  emergencyLoan: 0.75,
  thirdLoan: 2.0,
};

// Interest rates by tier (annual percentage)
const INTEREST_RATES = {
  bronze: 10,
  silver: 8,
  gold: 6,
  platinum: 5,
  emergency: 5,
};

// Loan eligibility criteria
const ELIGIBILITY = {
  minSavings: 70000,
  minMonths: 6,
  guarantorMinSavings: 70000,
  guarantorPercentageRequired: 25,
};

// Savings growth rate default (percentage)
const GROWTH_RATE_DEFAULT = 12.4;

module.exports = {
  GUARANTOR_MIN_SAVINGS,
  GUARANTOR_MIN_PERCENTAGE,
  MONTHLY_MINUTES_AMOUNT,
  MEMBERSHIP_FEE_AMOUNT,
  WITHDRAWAL_FEE,
  LATE_PENALTY_RATE,
  MIN_MONTHLY_SAVINGS,
  LOAN_TIERS,
  INTEREST_RATES,
  ELIGIBILITY,
  GROWTH_RATE_DEFAULT,
};
