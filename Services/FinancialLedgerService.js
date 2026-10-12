const { FinancialLedgerRepository } = require("../Repositories/FinancialLedgerRepository");

/**
 * Record a financial ledger entry.
 */
const recordEntry = async ({
  entryType,
  accountCategory,
  activityType,
  amount,
  reference,
  userId = null,
  relatedId = null,
  relatedModel = null,
  notes = "",
  session = null,
}) => {
  if (!amount || amount <= 0) return null;
  const eventKey = `${activityType}:${reference}`;
  const existing = await FinancialLedgerRepository.findByEventKey(eventKey, session);
  if (existing) return existing;
  return await FinancialLedgerRepository.createEntry(
    {
      entryType,
      accountCategory,
      activityType,
      amount,
      reference,
      eventKey,
      userId,
      relatedId,
      relatedModel,
      notes,
      status: "posted",
    },
    session
  );
};

/**
 * Calculate the verified cash position & comprehensive cooperative financial position
 */
const getFinancialPosition = async (dateRange = {}) => {
  const filter = {};
  if (dateRange.startDate || dateRange.endDate) {
    filter.createdAt = {};
    if (dateRange.startDate) filter.createdAt.$gte = new Date(dateRange.startDate);
    if (dateRange.endDate) filter.createdAt.$lte = new Date(dateRange.endDate);
  }

  const summaries = await FinancialLedgerRepository.aggregateSummary(filter);

  let totalInflows = 0;
  let totalOutflows = 0;
  let totalSavingsDeposits = 0;
  let totalMembershipFeeRevenue = 0;
  let totalLoanInterestRevenue = 0;
  let totalWithdrawalFeeRevenue = 0;
  let totalLoanDisbursements = 0;
  let totalWithdrawalPayouts = 0;
  let totalOperatingExpenses = 0;
  let totalReferralExpenses = 0;
  let totalLoanRepayments = 0;
  let totalMinutesContributions = 0;
  let startingCapital = 0;

  summaries.forEach((item) => {
    const { entryType, activityType } = item._id;
    const amount = item.totalAmount;

    if (entryType === "inflow") {
      totalInflows += amount;
    } else if (entryType === "outflow") {
      totalOutflows += amount;
    }

    switch (activityType) {
      case "savings_deposit":
        totalSavingsDeposits += amount;
        break;
      case "membership_fee":
        totalMembershipFeeRevenue += amount;
        break;
      case "minutes_fee":
        totalMinutesContributions += amount;
        break;
      case "loan_repayment_principal":
        totalLoanRepayments += amount;
        break;
      case "loan_repayment_interest":
        totalLoanInterestRevenue += amount;
        totalLoanRepayments += amount;
        break;
      case "withdrawal_fee":
        totalWithdrawalFeeRevenue += amount;
        break;
      case "loan_disbursement":
        totalLoanDisbursements += amount;
        break;
      case "withdrawal_payout":
        totalWithdrawalPayouts += amount;
        break;
      case "operating_expense":
        totalOperatingExpenses += amount;
        break;
      case "referral_reward":
        totalReferralExpenses += amount;
        break;
      case "starting_capital_injection":
        startingCapital += amount;
        break;
    }
  });

  const totalRevenue = totalMembershipFeeRevenue + totalLoanInterestRevenue + totalWithdrawalFeeRevenue;
  const totalExpenses = totalOperatingExpenses + totalReferralExpenses;
  const netOperatingIncome = totalRevenue - totalExpenses;
  const netCashPosition = startingCapital + totalInflows - totalOutflows;

  return {
    startingCapital,
    totalInflows,
    totalOutflows,
    netCashPosition,
    revenue: {
      totalRevenue,
      membershipFees: totalMembershipFeeRevenue,
      loanInterest: totalLoanInterestRevenue,
      withdrawalFees: totalWithdrawalFeeRevenue,
    },
    expenses: {
      totalExpenses,
      operatingExpenses: totalOperatingExpenses,
      referralRewards: totalReferralExpenses,
    },
    memberContributions: {
      savingsDeposits: totalSavingsDeposits,
      minutesContributions: totalMinutesContributions,
      loanRepayments: totalLoanRepayments,
    },
    disbursements: {
      loanDisbursements: totalLoanDisbursements,
      withdrawalsPaid: totalWithdrawalPayouts,
    },
    netOperatingIncome,
  };
};

const FinancialLedgerService = {
  recordEntry,
  getFinancialPosition,
  getEntries: (filter, page = 1, limit = 50) =>
    FinancialLedgerRepository.findEntries(filter, (page - 1) * limit, limit),
  countEntries: (filter) => FinancialLedgerRepository.countEntries(filter),
};

module.exports = { FinancialLedgerService };
