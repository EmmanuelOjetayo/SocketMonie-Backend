const bcrypt = require("bcrypt");
const { SavingsRepository } = require("../Repositories/SavingsRepository");
const { getMinCommitmentForTier, getTierBySavings, canUpgradeToTier } = require("../Utilis/tierService");
const { createNotification } = require("../Utilis/notificationHelper");
const { updateUserScore } = require("../Utilis/scoreService");
const AppError = require("../Utilis/AppError");
const { WITHDRAWAL_FEE, GROWTH_RATE_DEFAULT } = require("../Config/constants");

// Available balance: completed net savings minus withdrawals already reserved
// by pending/approved-but-unpaid requests (prevents concurrent double-spend).
const getAvailableSavings = async (userId) => {
  const netSavings = await SavingsRepository.getNetSavings(userId);
  const reserved = await SavingsRepository.getPendingWithdrawalDeductions(userId);
  return netSavings - reserved;
};

const getAverageMonthlySavings = async (userId) => {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const deposits = await SavingsRepository.findCompletedDepositsSince(userId, sixMonthsAgo);
  if (deposits.length === 0) return 0;

  const monthMap = {};
  deposits.forEach((d) => {
    const key = `${d.createdAt.getFullYear()}-${d.createdAt.getMonth()}`;
    monthMap[key] = (monthMap[key] || 0) + d.amount;
  });

  const total = Object.values(monthMap).reduce((a, b) => a + b, 0);
  const months = Object.keys(monthMap).length;
  return months > 0 ? total / months : 0;
};

const updateUserTierAndScore = async (userId, trigger = null) => {
  const avg = await getAverageMonthlySavings(userId);
  const newTier = getTierBySavings(avg);
  const user = await SavingsRepository.findUserById(userId);
  if (!user) return;

  let tierChanged = false;
  if (user.currentTier !== newTier) {
    user.currentTier = newTier;
    tierChanged = true;
    await createNotification({
      userId,
      type: "system",
      title: "Tier Update",
      message: `Your membership tier has been updated to ${newTier.charAt(0).toUpperCase() + newTier.slice(1)}.`,
    });
  }
  await updateUserScore(userId, trigger || (tierChanged ? "tier_update" : "savings_update"));
  if (tierChanged) await user.save();
};

const getMonthlySavingsReport = async (userId) => {
  const savingsList = await SavingsRepository.findCompletedForUser(userId);
  const now = new Date();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const reportMap = {};

  for (let i = 5; i >= 0; i -= 1) {
    reportMap[monthNames[new Date(now.getFullYear(), now.getMonth() - i, 1).getMonth()]] = 0;
  }

  savingsList.forEach((item) => {
    const month = monthNames[new Date(item.createdAt).getMonth()];
    if (reportMap[month] !== undefined) reportMap[month] += item.amount;
  });

  return Object.keys(reportMap).map((month) => ({ month, amount: reportMap[month] }));
};

// Helper: compute MoM growth rate from completed deposits
const computeMoMGrowthRate = async (userId) => {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const deposits = await SavingsRepository.findCompletedDepositsSince(userId, twelveMonthsAgo);
  if (deposits.length < 2) return 0; // Not enough data for growth rate

  // Group deposits by month
  const monthMap = {};
  deposits.forEach((d) => {
    const key = `${d.createdAt.getFullYear()}-${d.createdAt.getMonth()}`;
    monthMap[key] = (monthMap[key] || 0) + d.amount;
  });

  // Get last two months sorted chronologically
  const months = Object.keys(monthMap).sort();
  if (months.length < 2) return 0;

  const [prevMonth, currMonth] = months.slice(-2); // last two = most recent
  const prevAmount = monthMap[prevMonth];
  const currAmount = monthMap[currMonth];

  if (prevAmount === 0) return 0; // Avoid division by zero

  return ((currAmount - prevAmount) / prevAmount) * 100;
};

const getSavingsSummary = async (userId) => {
  const savingsList = await SavingsRepository.findCompletedForUser(userId);
  const totalSaved = savingsList.reduce(
    (total, item) => total + (item.type === "withdrawal" ? -item.amount : item.type === "deposit" ? item.amount : 0),
    0
  );
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const monthlyContributed = savingsList
    .filter((item) => item.type === "deposit" && new Date(item.createdAt) >= startOfMonth)
    .reduce((total, item) => total + item.amount, 0);

  const user = await SavingsRepository.findUserSummary(userId);
  const currentTier = user?.tier || "Bronze";
  const tierMin = getMinCommitmentForTier(currentTier);
  const monthlyTarget = user?.monthlySavingsCommitment > 0 ? user.monthlySavingsCommitment : tierMin;

  const growthRatePct = await computeMoMGrowthRate(userId);

  // Available balance: net completed savings minus withdrawals already reserved
  // by pending/approved-but-unpaid requests (P3 item 21/22 hardening).
  const reservedBalance = await SavingsRepository.getPendingWithdrawalDeductions(userId);
  const availableBalance = Math.max(0, Number(totalSaved) - Number(reservedBalance));

  return {
    totalSaved,
    availableBalance,
    reservedBalance,
    currentTier,
    monthlyTarget,
    monthlyContributed,
    monthCompletion: Math.min(100, Math.round((monthlyContributed / monthlyTarget) * 100)),
    isTierTargetMet: monthlyContributed >= monthlyTarget,
    growthRatePct,
  };
};

const getSavingsHistory = async (userId, page, limit) => {
  const skip = (page - 1) * limit;
  const [total, savingsList] = await Promise.all([
    SavingsRepository.countForUser(userId),
    SavingsRepository.findForUser(userId, skip, limit),
  ]);

  const toIsoDate = (value) => {
    const d = value ? new Date(value) : new Date();
    return Number.isNaN(d.getTime()) ? new Date().toISOString().split("T")[0] : d.toISOString().split("T")[0];
  };

  return {
    history: savingsList.map((item) => ({
      id: item._id,
      // historyDisplayAt is a separate non-audit display date for history views.
      date: toIsoDate(item.historyDisplayAt || item.createdAt),
      amount: item.amount,
      type: item.type,
      method: item.method,
      status: item.status,
    })),
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
};

const withdrawFromSavings = async ({ userId, amount, method, bankDetails, pin }) => {
  if (!amount || amount <= 0) {
    throw new AppError("Please enter a valid amount.", 400);
  }

  const user = await SavingsRepository.findUserById(userId);
  if (!user || !user.transactionPin) {
    throw new AppError("Transaction PIN not set.", 400);
  }

  const isPinValid = await bcrypt.compare(pin, user.transactionPin);
  if (!isPinValid) {
    throw new AppError("Invalid transaction PIN.", 400);
  }

  const netSavings = await getAvailableSavings(userId);
  const standardFee = WITHDRAWAL_FEE;
  const totalDeduction = Number(amount) + standardFee;

  if (netSavings < totalDeduction) {
    throw new AppError(
      `Insufficient savings balance. Available: ₦${netSavings.toLocaleString()}. Total required (including ₦${standardFee} fee): ₦${totalDeduction.toLocaleString()}`,
      400
    );
  }

  const withdrawal = await SavingsRepository.createSavingsRecord({
    userId,
    amount: totalDeduction,
    type: "withdrawal",
    method: method || "Bank Transfer",
    status: "completed",
    fee: standardFee,
    reference: `WTH-${Date.now()}`,
  });

  await updateUserTierAndScore(userId, "withdrawal");

  await createNotification({
    userId,
    type: "savings",
    title: "Withdrawal Successful",
    message: `Withdrew ₦${Number(amount).toLocaleString()} from your savings account. Fee: ₦${standardFee}`,
  });

  return {
    withdrawalId: withdrawal._id,
    payoutAmount: Number(amount),
    fee: standardFee,
    totalDeducted: totalDeduction,
    newBalance: netSavings - totalDeduction,
    reference: withdrawal.reference,
    destinationBank: bankDetails || user.bankDetails,
  };
};

const requestWithdrawal = async ({ userId, amount, accountNumber, accountName, bankName, pin }) => {
  if (!amount || amount <= 0) {
    throw new AppError("Please enter a valid amount.", 400);
  }

  const netSavings = await getAvailableSavings(userId);
  const fee = WITHDRAWAL_FEE;
  const totalDeduction = Number(amount) + fee;

  if (netSavings < totalDeduction) {
    throw new AppError(`Insufficient balance. Available: ₦${netSavings.toLocaleString()}`, 400);
  }

  const user = await SavingsRepository.findUserById(userId);
  if (!user || !user.transactionPin) {
    throw new AppError("Transaction PIN not set.", 400);
  }

  const savedBankDetails = user.bankDetails || {};
  if (
    savedBankDetails.accountNumber !== accountNumber ||
    savedBankDetails.accountName !== accountName ||
    savedBankDetails.bankName !== bankName
  ) {
    throw new AppError("Withdrawal bank details must match your saved profile details.", 400);
  }

  const isPinValid = await bcrypt.compare(pin, user.transactionPin);
  if (!isPinValid) {
    throw new AppError("Invalid transaction PIN.", 400);
  }

  const withdrawalRequest = await SavingsRepository.createSavingsRecord({
    userId,
    amount: Number(amount),
    type: "withdrawal",
    method: "flutterwave_payout",
    status: "pending_approval",
    fee,
    reference: `WTH_REQ_${Date.now()}`,
    bankDetails: {
      bankCode: user.bankDetails?.bankCode || null,
      bankName: savedBankDetails.bankName,
      accountNumber: savedBankDetails.accountNumber,
      accountName: savedBankDetails.accountName,
    },
  });

  await createNotification({
    userId,
    type: "savings",
    title: "Withdrawal Request Submitted",
    message: `Your withdrawal request of ₦${Number(amount).toLocaleString()} has been submitted for approval.`,
    data: {
      action: "withdrawal_submitted",
      withdrawalId: withdrawalRequest._id,
      amount: Number(amount),
      fee,
      totalDeducted: Number(amount) + fee,
      destinationBank: withdrawalRequest.bankDetails,
      status: withdrawalRequest.status,
      reference: withdrawalRequest.reference,
    },
  });

  const admins = await SavingsRepository.findAdminsForNotification();
  for (const admin of admins) {
    await createNotification({
      userId: admin._id,
      type: "system",
      title: "New Withdrawal Request",
      message: `${user.fullName} has requested a withdrawal of ₦${Number(amount).toLocaleString()}.`,
      data: { withdrawalId: withdrawalRequest._id, userId: user._id },
    });
  }

  return {
    withdrawalId: withdrawalRequest._id,
    reference: withdrawalRequest.reference,
    status: withdrawalRequest.status,
    amount: Number(amount),
    fee,
    totalDeducted: Number(amount) + fee,
    destinationBank: withdrawalRequest.bankDetails,
  };
};

const updateTierCommitment = async ({ userId, newTier, newCommitment }) => {
  const targetTierKey = (newTier || "").toLowerCase();
  const validTiers = ["bronze", "silver", "gold", "platinum"];

  if (!validTiers.includes(targetTierKey)) {
    throw new AppError("Invalid membership tier selected.", 400);
  }

  const user = await SavingsRepository.findUserById(userId);
  if (!user) {
    throw new AppError("User not found.", 404);
  }

  const upgradeCheck = canUpgradeToTier(user, targetTierKey);
  if (!upgradeCheck.canUpgrade) {
    const err = new AppError("Cannot upgrade tier at this time.", 400);
    err.reasons = upgradeCheck.reasons;
    throw err;
  }

  const minRequired = getMinCommitmentForTier(targetTierKey);
  if (newCommitment < minRequired) {
    throw new AppError(
      `Minimum monthly commitment for ${targetTierKey.toUpperCase()} tier is ₦${minRequired.toLocaleString()}.`,
      400
    );
  }

  const formattedTier = targetTierKey.charAt(0).toUpperCase() + targetTierKey.slice(1);
  user.tier = formattedTier;
  user.monthlySavingsCommitment = newCommitment;
  await user.save();

  return {
    tier: user.tier,
    monthlySavingsCommitment: user.monthlySavingsCommitment,
    formattedTier,
  };
};

const SavingsService = {
  getSavingsSummary,
  getMonthlySavingsReport,
  getSavingsHistory,
  withdrawFromSavings,
  requestWithdrawal,
  updateTierCommitment,
  updateUserTierAndScore,
};

module.exports = { SavingsService };
