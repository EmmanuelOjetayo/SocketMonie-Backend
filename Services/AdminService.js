const mongoose = require("mongoose");
const { AdminRepository } = require("../Repositories/AdminRepository");
const Loan = require("../Models/LoanModel");
const User = require("../Models/UserModel");
const { createNotification, broadcastNotification } = require("../Utilis/notificationHelper");
const { updateUserScore } = require("../Utilis/scoreService");
const { FinancialLedgerService } = require("./FinancialLedgerService");
const { logAudit } = require("../Utilis/auditLogger");
const AppError = require("../Utilis/AppError");

const defaultSettings = {
  loanTiers: { firstLoan: 0.7, secondLoan: 1.0, thirdLoan: 1.5 },
  interestRates: { bronze: 10, silver: 8, gold: 6, platinum: 5 },
  eligibility: { minSavings: 70000, minMonths: 6 },
  withdrawalFee: 100,
  latePenaltyRate: 2,
};

const getMembers = async ({ page, limit, status, search }) => {
  const query = { role: "member" };
  if (status) query.status = status;
  if (search) {
    query.$or = [
      { fullName: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
    ];
  }
  const [total, members] = await Promise.all([
    AdminRepository.countUsers(query),
    AdminRepository.findMembers(query, (page - 1) * limit, limit),
  ]);
  return {
    members,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPrevPage: page > 1,
    },
  };
};

const getMemberDetails = async (userId) => {
  const member = await AdminRepository.findMember(userId);
  if (!member) throw new AppError("Member not found", 404);
  const [deposits, withdrawals, loans, scoreHistory] = await Promise.all([
    AdminRepository.findSavings({ userId, type: "deposit", status: "completed" }),
    AdminRepository.findSavings({ userId, type: "withdrawal", status: "completed" }),
    Loan.find({ userId }),
    AdminRepository.findScoreHistory(userId),
  ]);
  return {
    member,
    stats: {
      totalSavings: deposits.reduce((sum, item) => sum + item.amount, 0) - withdrawals.reduce((sum, item) => sum + item.amount, 0),
      totalWithdrawn: withdrawals.reduce((sum, item) => sum + item.amount, 0),
      activeLoansCount: loans.filter((loan) =>
        ["active", "warning_30_days", "defaulted_60_days", "restricted_90_days", "recovery_120_days"].includes(loan.status)
      ).length,
      totalLoanAmount: loans.reduce((sum, loan) => sum + (loan.principalAmount || 0), 0),
    },
    scoreHistory,
  };
};

const setMemberStatus = async (userId, status, reason = "", adminUser = {}, clientIp = "", userAgent = "") => {
  const user = await AdminRepository.findUserDocument(userId);
  if (!user) throw new AppError("User not found.", 404);
  if (status === "suspended" && user.role === "super_admin") {
    throw new AppError("Cannot suspend a Super Admin.", 403);
  }
  user.status = status;
  await user.save();

  if (status === "suspended") {
    await createNotification({
      userId,
      type: "system",
      title: "Account Suspended",
      message: `Your account has been suspended. Reason: ${reason || "Violation of terms."}`,
    });
    if (adminUser?._id) {
      await logAudit({
        userId: adminUser._id,
        userEmail: adminUser.email,
        userRole: adminUser.role,
        action: "member_suspend",
        targetType: "user",
        targetId: userId,
        details: { reason, suspendedBy: adminUser._id },
        ipAddress: clientIp,
        userAgent,
      });
    }
  } else {
    await createNotification({
      userId,
      type: "system",
      title: "Account Activated",
      message: "Your account has been reactivated.",
    });
    if (adminUser?._id) {
      await logAudit({
        userId: adminUser._id,
        userEmail: adminUser.email,
        userRole: adminUser.role,
        action: "member_activate",
        targetType: "user",
        targetId: userId,
        details: { activatedBy: adminUser._id },
        ipAddress: clientIp,
        userAgent,
      });
    }
  }

  return user;
};

const updateKyc = async (userId, status, reason = "", adminUser = {}, clientIp = "", userAgent = "") => {
  const user = await AdminRepository.findUserDocument(userId);
  if (!user) throw new AppError("User not found.", 404);

  user.kycStatus = status;
  if (status === "approved") {
    user.kycVerifiedAt = new Date();
    await user.save();
    await updateUserScore(userId, "kyc_approved");
    await createNotification({
      userId,
      type: "system",
      title: "KYC Approved",
      message: "Your KYC documents have been approved!",
    });
    if (adminUser?._id) {
      await logAudit({
        userId: adminUser._id,
        userEmail: adminUser.email,
        userRole: adminUser.role,
        action: "kyc_approve",
        targetType: "user",
        targetId: userId,
        details: { approvedBy: adminUser._id },
        ipAddress: clientIp,
        userAgent,
      });
    }
  } else {
    user.kycRejectionReason = reason;
    await user.save();
    await createNotification({
      userId,
      type: "system",
      title: "KYC Rejected",
      message: `Your KYC documents were rejected. Reason: ${reason}`,
    });
    if (adminUser?._id) {
      await logAudit({
        userId: adminUser._id,
        userEmail: adminUser.email,
        userRole: adminUser.role,
        action: "kyc_reject",
        targetType: "user",
        targetId: userId,
        details: { reason, rejectedBy: adminUser._id },
        ipAddress: clientIp,
        userAgent,
      });
    }
  }
  return user;
};

const getLoans = async ({ status, page, limit, search }) => {
  const filter = {};
  if (status) filter.status = status;
  if (search) {
    const users = await User.find({ fullName: { $regex: search, $options: "i" } }).select("_id");
    filter.$or = [{ _id: { $regex: search, $options: "i" } }, { userId: { $in: users.map((u) => u._id) } }];
  }
  const [total, loans] = await Promise.all([
    AdminRepository.countLoans(filter),
    AdminRepository.findLoans(filter, (page - 1) * limit, limit),
  ]);
  return { loans, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
};

const getLoan = async (loanId) => {
  const loan = await AdminRepository.findLoan(loanId);
  if (!loan) throw new AppError("Loan not found.", 404);
  return loan;
};

const rejectLoan = async (loanId, reason, adminUser = {}, clientIp = "", userAgent = "") => {
  const loan = await AdminRepository.findPendingLoan(loanId);
  if (!loan) throw new AppError("Loan not found or has already been processed.", 404);

  loan.status = "rejected";
  loan.rejectionReason = reason;
  loan.rejectedAt = new Date();
  loan.rejectedBy = adminUser?._id;
  await loan.save();

  await createNotification({
    userId: loan.userId._id,
    type: "loan",
    title: "Loan Application Rejected",
    message: `Unfortunately, your loan application was rejected.\nReason: ${reason}`,
  });

  if (adminUser?._id) {
    await logAudit({
      userId: adminUser._id,
      userEmail: adminUser.email,
      userRole: adminUser.role,
      action: "loan_rejected",
      targetType: "loan",
      targetId: loan._id,
      details: {
        reason,
        member: loan.userId._id,
      },
      ipAddress: clientIp,
      userAgent,
    });
  }

  return loan;
};

const getSettings = async () => {
  return (await AdminRepository.findSettings()) || (await AdminRepository.createSettings(defaultSettings));
};

const updateSystemSettings = async (updates, adminUser = {}, clientIp = "", userAgent = "") => {
  let settings = await AdminRepository.findSettings();
  if (!settings) settings = await AdminRepository.createSettings(defaultSettings);

  const changedFields = [];
  if (updates.loanTiers) {
    if (settings.loanTiers?.firstLoan !== updates.loanTiers.firstLoan) changedFields.push("First-time loan percentage");
    if (settings.loanTiers?.secondLoan !== updates.loanTiers.secondLoan) changedFields.push("Second loan percentage");
    if (settings.loanTiers?.thirdLoan !== updates.loanTiers.thirdLoan) changedFields.push("Third+ loan percentage");
    settings.loanTiers = { ...settings.loanTiers, ...updates.loanTiers };
  }
  if (updates.interestRates) {
    if (settings.interestRates?.bronze !== updates.interestRates.bronze) changedFields.push("Bronze tier interest rate");
    if (settings.interestRates?.silver !== updates.interestRates.silver) changedFields.push("Silver tier interest rate");
    if (settings.interestRates?.gold !== updates.interestRates.gold) changedFields.push("Gold tier interest rate");
    if (settings.interestRates?.platinum !== updates.interestRates.platinum) changedFields.push("Platinum tier interest rate");
    settings.interestRates = { ...settings.interestRates, ...updates.interestRates };
  }
  if (updates.eligibility) {
    if (settings.eligibility?.minSavings !== updates.eligibility.minSavings) changedFields.push("Minimum savings requirement");
    if (settings.eligibility?.minMonths !== updates.eligibility.minMonths) changedFields.push("Minimum months requirement");
    settings.eligibility = { ...settings.eligibility, ...updates.eligibility };
  }
  if (updates.withdrawalFee !== undefined) {
    if (settings.withdrawalFee !== updates.withdrawalFee) changedFields.push("Withdrawal fee");
    settings.withdrawalFee = updates.withdrawalFee;
  }
  if (updates.latePenaltyRate !== undefined) {
    if (settings.latePenaltyRate !== updates.latePenaltyRate) changedFields.push("Late payment penalty rate");
    settings.latePenaltyRate = updates.latePenaltyRate;
  }

  settings.updatedAt = new Date();
  settings.updatedBy = adminUser?._id;
  await settings.save();

  if (changedFields.length > 0) {
    await broadcastNotification({
      type: "system",
      title: "System Settings Updated",
      message: `The following system settings have been updated: ${changedFields.join(", ")}. Please review your loan policies and rates.`,
      excludeUserIds: adminUser?._id ? [adminUser._id] : [],
    });
    if (adminUser?._id) {
      await createNotification({
        userId: adminUser._id,
        type: "system",
        title: "Settings Updated",
        message: `System settings updated successfully: ${changedFields.join(", ")}.`,
      });
      await logAudit({
        userId: adminUser._id,
        userEmail: adminUser.email,
        userRole: adminUser.role,
        action: "settings_update",
        targetType: "system",
        details: { updatedFields: changedFields, newSettings: updates },
        ipAddress: clientIp,
        userAgent,
      });
    }
  }

  return { changedFields, settings };
};

const getTierRequests = async ({ status = "pending", page = 1, limit = 20 }) => {
  const filter = { "tierUpgradeRequest.status": status };
  const [total, users] = await Promise.all([
    AdminRepository.countUsers(filter),
    AdminRepository.findTierRequests(filter, (page - 1) * limit, limit),
  ]);
  return { users, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
};

const getPendingWithdrawals = async ({ page = 1, limit = 20 }) => {
  const filter = { status: "pending_approval", type: "withdrawal" };
  const [total, withdrawals] = await Promise.all([
    AdminRepository.countSavings(filter),
    AdminRepository.findWithdrawals(filter, (page - 1) * limit, limit),
  ]);
  return { withdrawals, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
};

const approveWithdrawal = async (withdrawalId, adminUser = {}, clientIp = "", userAgent = "") => {
  const session = await mongoose.startSession();
  let completedWithdrawal;
  let totalDeducted = 0;
  let user;

  try {
    await session.withTransaction(async () => {
      const withdrawal = await AdminRepository.findWithdrawalById(withdrawalId, session);
      if (!withdrawal) throw new AppError("Withdrawal not found.", 404);
      if (withdrawal.status !== "pending_approval") {
        throw new AppError("Withdrawal is not pending approval.", 400);
      }

      user = await AdminRepository.findUserDocument(withdrawal.userId, session);
      if (!user) throw new AppError("User not found.", 404);

      const fee = withdrawal.fee || 0;
      totalDeducted = withdrawal.amount + fee;

      // Ensure user has adequate balance
      if (user.savingsBalance !== undefined) {
        user.savingsBalance -= totalDeducted;
        if (user.savingsBalance < 0) {
          throw new AppError("Insufficient savings balance.", 400);
        }
        await AdminRepository.saveDocument(user, session);
      }

      withdrawal.status = "completed";
      withdrawal.approvedAt = new Date();
      withdrawal.completedAt = new Date();
      withdrawal.totalDeducted = totalDeducted;

      await AdminRepository.saveDocument(withdrawal, session);
      await FinancialLedgerService.recordEntry({
        entryType: "outflow",
        accountCategory: "cash_asset",
        activityType: "withdrawal_payout",
        amount: withdrawal.amount,
        reference: withdrawal.reference,
        userId: withdrawal.userId,
        relatedId: withdrawal._id,
        relatedModel: "Savings",
        notes: "Approved withdrawal payout",
        session,
      });
      if (fee > 0) {
        await FinancialLedgerService.recordEntry({
          entryType: "inflow",
          accountCategory: "withdrawal_fee_revenue",
          activityType: "withdrawal_fee",
          amount: fee,
          reference: `${withdrawal.reference}:fee`,
          userId: withdrawal.userId,
          relatedId: withdrawal._id,
          relatedModel: "Savings",
          notes: "Withdrawal processing fee",
          session,
        });
      }
      completedWithdrawal = withdrawal;
    });
  } finally {
    await session.endSession();
  }

  await createNotification({
    userId: completedWithdrawal.userId,
    type: "savings",
    title: "Withdrawal Approved",
    message: `Your withdrawal of ₦${completedWithdrawal.amount.toLocaleString()} has been approved successfully.`,
    data: {
      action: "withdrawal_successful",
      withdrawalId: completedWithdrawal._id,
      amount: completedWithdrawal.amount,
      fee: completedWithdrawal.fee || 0,
      totalDeducted,
      status: "successful",
    },
  });

  if (adminUser?._id) {
    await logAudit({
      userId: adminUser._id,
      userEmail: adminUser.email,
      userRole: adminUser.role,
      action: "withdrawal_approve",
      targetType: "savings",
      targetId: withdrawalId,
      details: {
        amount: completedWithdrawal.amount,
        fee: completedWithdrawal.fee || 0,
        totalDeducted,
        approvedBy: adminUser._id,
      },
      ipAddress: clientIp,
      userAgent,
    });
  }

  return {
    withdrawal: completedWithdrawal,
    amount: completedWithdrawal.amount,
    fee: completedWithdrawal.fee || 0,
    totalDeducted,
    status: "successful",
  };
};

const rejectWithdrawal = async (withdrawalId, reason, adminUser = {}) => {
  const withdrawal = await AdminRepository.findWithdrawalById(withdrawalId);
  if (!withdrawal) throw new AppError("Withdrawal not found.", 404);
  if (withdrawal.status !== "pending_approval") {
    throw new AppError("Withdrawal is not pending approval.", 400);
  }

  withdrawal.status = "rejected";
  withdrawal.rejectionReason = reason;
  withdrawal.rejectedAt = new Date();
  await withdrawal.save();

  await createNotification({
    userId: withdrawal.userId,
    type: "savings",
    title: "Withdrawal Rejected",
    message: `Your withdrawal request of ₦${withdrawal.amount.toLocaleString()} was rejected. Reason: ${reason}`,
    data: {
      action: "withdrawal_rejected",
      withdrawalId: withdrawal._id,
      amount: withdrawal.amount,
      fee: withdrawal.fee || 0,
      totalDeducted: 0,
      destinationBank: withdrawal.bankDetails,
      status: "rejected",
      rejectionReason: reason,
      reference: withdrawal.reference,
    },
  });

  return withdrawal;
};

const getAdminReports = async ({ type = "overview" }) => {
  let reports = [];
  let stats = {};

  switch (type) {
    case "savings":
      reports = await AdminRepository.findSavingsReport({ status: "completed", type: { $in: ["deposit", "withdrawal"] } });
      stats.totalAmount = reports.reduce((sum, item) => sum + (item.type === "withdrawal" ? -item.amount : item.amount), 0);
      break;

    case "loans":
      reports = await AdminRepository.findLoanReport();
      stats.totalAmount = reports.reduce((sum, item) => sum + item.principalAmount, 0);
      break;

    case "revenue":
      reports = await AdminRepository.findActiveLoanReport();
      stats.totalAmount = reports.reduce((sum, item) => sum + (item.interestAmount || 0), 0);
      break;

    default:
      stats = await AdminRepository.getOverviewAggregates();
  }

  return {
    stats,
    reports,
    totalAmount: stats.totalAmount || 0,
  };
};

const AdminService = {
  getMembers,
  getMemberDetails,
  setMemberStatus,
  updateKyc,
  getLoans,
  getLoan,
  rejectLoan,
  getSettings,
  updateSystemSettings,
  getTierRequests,
  getPendingWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  getAdminReports,
};

module.exports = { AdminService };