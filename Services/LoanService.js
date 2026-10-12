const mongoose = require("mongoose");
const crypto = require("crypto");
const { LoanRepository } = require("../Repositories/LoanRepository");
const { InterestCalculationService } = require("./InterestCalculationService");
const { FinancialLedgerService } = require("./FinancialLedgerService");
const { createNotification } = require("../Utilis/notificationHelper");
const { updateUserScore } = require("../Utilis/scoreService");
const { logAudit } = require("../Utilis/auditLogger");
const { verifyPayment, verifyTransactionById, FLW_PUBLIC_KEY, FLW_SUBACCOUNT_ID } = require("../Utilis/Flutterwave");
const { runLoanDefaulterEscalation } = require("../Utilis/loanDefaulterEngine");
const AppError = require("../Utilis/AppError");
const {
  GUARANTOR_MIN_SAVINGS,
  GUARANTOR_MIN_PERCENTAGE,
  LATE_PENALTY_RATE,
  LOAN_TIERS,
  INTEREST_RATES,
  ELIGIBILITY,
} = require("../../Config/constants");

const getNetSavings = async (userId) => {
  const completedSavings = await LoanRepository.findCompletedSavings(userId);
  return completedSavings.reduce((sum, item) => {
    if (item.type === "withdrawal") return sum - item.amount;
    if (item.type === "deposit") return sum + item.amount;
    return sum;
  }, 0);
};

const checkSavingsConsistency = async (userId) => {
  const deposits = await LoanRepository.findCompletedDeposits(userId);
  const monthlySavings = {};
  deposits.forEach((deposit) => {
    const date = new Date(deposit.createdAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    monthlySavings[key] = (monthlySavings[key] || 0) + deposit.amount;
  });

  const today = new Date();
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if ((monthlySavings[key] || 0) < 5000) return false;
  }
  return true;
};

const countSavingsMonths = async (userId) => {
  const deposits = await LoanRepository.findCompletedDeposits(userId);
  return new Set(
    deposits.map((deposit) => {
      const date = new Date(deposit.createdAt);
      return `${date.getFullYear()}-${date.getMonth()}`;
    })
  ).size;
};

const getSystemSettings = async () => {
  let settings = await LoanRepository.findSettings();
  if (!settings) {
    settings = await LoanRepository.createSettings({
      loanTiers: LOAN_TIERS,
      interestRates: INTEREST_RATES,
      eligibility: ELIGIBILITY,
      withdrawalFee: 100,
      latePenaltyRate: LATE_PENALTY_RATE,
    });
  }
  return settings;
};

/**
 * Loan Eligibility Calculation:
 * - 1st regular loan: 150% (1.5x net savings)
 * - 2nd & subsequent regular loans: 200% (2.0x net savings)
 * - Emergency loan: 75% (0.75x net savings), independent of regular loan progression.
 */
const getEligibility = async (userId, loanType = "cooperative") => {
  const settings = await getSystemSettings();
  const isEmergency = loanType === "emergency";

  const [netSavings, isConsistent, monthsCount, completedRegularLoansCount] = await Promise.all([
    getNetSavings(userId),
    checkSavingsConsistency(userId),
    countSavingsMonths(userId),
    LoanRepository.count({ userId, status: "completed", loanType: { $ne: "emergency" } }),
  ]);

  let tierPercentage;
  let tierName;

  if (isEmergency) {
    tierPercentage = settings.loanTiers?.emergencyLoan || 0.75;
    tierName = "emergency_75";
  } else if (completedRegularLoansCount === 0) {
    tierPercentage = settings.loanTiers?.firstLoan || 1.5;
    tierName = "1st_tier_150";
  } else {
    tierPercentage = settings.loanTiers?.secondLoan || 2.0;
    tierName = "2nd_tier_200";
  }

  const meetsSavingsThreshold = netSavings >= settings.eligibility.minSavings;
  const isEligible = isConsistent && meetsSavingsThreshold && monthsCount >= settings.eligibility.minMonths;

  return {
    isEligible,
    isConsistent,
    meetsSavingsThreshold,
    netSavings,
    maxLoanAmount: isEligible ? Math.round(netSavings * tierPercentage) : 0,
    tierPercentage,
    tierName,
    completedRegularLoansCount,
    monthsCount,
    minSavings: settings.eligibility.minSavings,
    minMonths: settings.eligibility.minMonths,
    isEmergency,
  };
};

const getActiveLoan = async (userId) => {
  return await LoanRepository.findActiveForUser(userId);
};

const getById = async (loanId, userId, role) => {
  const loan = await LoanRepository.findById(loanId);
  if (!loan) throw new AppError("Loan not found.", 404);
  if (loan.userId.toString() !== userId.toString() && role !== "super_admin" && role !== "finance_manager") {
    throw new AppError("Access denied.", 403);
  }
  return loan;
};

const getSchedule = async (loanId, userId, role) => {
  const loan = await getById(loanId, userId, role);
  return {
    schedule: loan.installments || [],
    nextDue: loan.installments?.find((item) => item.status !== "paid") || null,
  };
};

const getHistory = async (userId, status, page = 1, limit = 10) => {
  const filter = { userId };
  if (status) filter.status = status;
  const total = await LoanRepository.count(filter);
  const loans = await LoanRepository.findHistory(filter, (page - 1) * limit, limit);
  const [completed, active, defaulted] = await Promise.all([
    LoanRepository.count({ userId, status: "completed" }),
    LoanRepository.count({ userId, status: { $in: ["active", "warning_30_days"] } }),
    LoanRepository.count({ userId, status: "defaulted_60_days" }),
  ]);
  return {
    loans,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    stats: { totalLoans: total, completed, active, defaulted },
  };
};

const applyForLoan = async ({
  userId,
  amount,
  durationMonths,
  loanType = "cooperative",
  disbursementMethod,
  purpose,
  guarantorReferralCodes,
}) => {
  const referralCodes = Array.isArray(guarantorReferralCodes)
    ? guarantorReferralCodes.map((c) => String(c || "").trim().toUpperCase()).filter(Boolean)
    : [];

  if (referralCodes.length !== 4 || new Set(referralCodes).size !== 4) {
    throw new AppError("Four different guarantor referral codes are required.", 400);
  }

  const existingLoan = await LoanRepository.findActiveForUser(userId);
  if (existingLoan) {
    let message = "You already have an active or processing loan.";
    if (existingLoan.status === "waiting_guarantor") {
      message = "You have a loan application awaiting guarantor approval.";
    } else if (existingLoan.status === "pending_review") {
      message = "You already have a loan awaiting admin approval.";
    }
    throw new AppError(message, 400);
  }

  const eligibility = await getEligibility(userId, loanType);
  if (!eligibility.isEligible) {
    throw new AppError(
      `You must save consistently for at least ${eligibility.minMonths} months and maintain a minimum net savings of ₦${eligibility.minSavings.toLocaleString()}.`,
      400
    );
  }

  if (Number(amount) > eligibility.maxLoanAmount) {
    throw new AppError(`Maximum loan you can access is ₦${eligibility.maxLoanAmount.toLocaleString()}.`, 400);
  }

  const user = await LoanRepository.findUserById(userId);

  // Calculate interest through centralized service
  const interestCalc = await InterestCalculationService.calculateInterest({
    loanType,
    userTier: user.tier || "Bronze",
    socketScore: user.socketScore || 0,
    principalAmount: Number(amount),
  });

  const interestRate = interestCalc.interestRate;
  const interestAmount = interestCalc.interestAmount;
  const totalRepayable = Number(amount) + interestAmount;
  const disbursementAmount = Number(amount) - interestAmount;

  const activeStatuses = [
    "waiting_guarantor",
    "pending_review",
    "active",
    "warning_30_days",
    "defaulted_60_days",
    "restricted_90_days",
    "recovery_120_days",
  ];

  const guarantors = [];
  const requiredGuarantorSavings = Number(amount) * GUARANTOR_MIN_PERCENTAGE; // Must be strictly greater than 25%

  for (const code of referralCodes) {
    const guarantor = await LoanRepository.findUserByReferralCode(code);
    if (!guarantor) throw new AppError(`Guarantor ${code} was not found.`, 404);
    if (guarantor._id.toString() === userId.toString()) {
      throw new AppError("You cannot select yourself as a guarantor.", 400);
    }

    const activeGuarantee = await LoanRepository.findActiveGuaranteeForGuarantor(guarantor._id, activeStatuses);
    if (activeGuarantee) {
      throw new AppError(`${guarantor.fullName} is already serving as an active guarantor on another loan.`, 400);
    }

    const gNetSavings = await getNetSavings(guarantor._id);
    if (gNetSavings < GUARANTOR_MIN_SAVINGS) {
      throw new AppError(`${guarantor.fullName} does not meet the minimum savings requirement of ₦${GUARANTOR_MIN_SAVINGS.toLocaleString()}.`, 400);
    }

    if (gNetSavings <= requiredGuarantorSavings) {
      throw new AppError(
        `${guarantor.fullName}'s savings (₦${gNetSavings.toLocaleString()}) must be greater than 25% of the loan amount (₦${requiredGuarantorSavings.toLocaleString()}).`,
        400
      );
    }

    guarantors.push({
      user: guarantor,
      verificationToken: crypto.randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
  }

  const session = await mongoose.startSession();
  let createdLoan;
  try {
    await session.withTransaction(async () => {
      const loanNumber = await LoanRepository.generateLoanNumber();
      const loanData = {
        userId,
        loanNumber,
        principalAmount: Number(amount),
        interestRate,
        interestAmount,
        totalRepayable,
        disbursementAmount,
        durationMonths,
        amountPaid: 0,
        remainingBalance: totalRepayable,
        tier: eligibility.tierName,
        status: "waiting_guarantor",
        installments: [],
        loanType: loanType || "cooperative",
        disbursementMethod: disbursementMethod || "bank_transfer",
        purpose: purpose || "",
        socketScore: user.socketScore || 0,
        interestSnapshot: {
          rate: interestRate,
          amount: interestAmount,
          ruleName: interestCalc.ruleName,
          ruleVersion: interestCalc.ruleVersion,
          calculatedAt: new Date(),
        },
        eligibilitySnapshot: {
          netSavings: eligibility.netSavings,
          maxLoanAmount: eligibility.maxLoanAmount,
          tier: eligibility.tierName,
          isEmergency: eligibility.isEmergency,
        },
        guarantors: guarantors.map(({ user: g, verificationToken }) => ({
          userId: g._id,
          fullName: g.fullName,
          email: g.email,
          phone: g.phone,
          referralCode: g.referralCode,
          status: "pending",
          verificationToken,
          guaranteedAmount: totalRepayable,
          remainingGuaranteedBalance: totalRepayable,
          isReplaced: false,
        })),
      };

      const guarantorsData = guarantors.map(({ user: g, verificationToken, expiresAt }) => ({
        applicantId: userId,
        guarantorUserId: g._id,
        guarantorName: g.fullName,
        guarantorEmail: g.email,
        guarantorPhone: g.phone || "Not provided",
        relationship: "cooperative member",
        guaranteedAmount: totalRepayable,
        remainingGuaranteedBalance: totalRepayable,
        verificationToken,
        tokenExpiresAt: expiresAt,
        status: "pending",
        isReplaced: false,
      }));

      createdLoan = await LoanRepository.createLoanWithGuarantors(loanData, guarantorsData, session);
    });
  } finally {
    await session.endSession();
  }

  await Promise.all([
    createNotification({
      userId,
      type: "loan",
      title: "Loan Application Submitted",
      message: "Your loan application has been submitted and is awaiting guarantor confirmation.",
    }),
    ...guarantors.map(({ user: g, verificationToken }) =>
      createNotification({
        userId: g._id,
        type: "loan",
        title: "Loan Guarantee Request",
        message: `${user.fullName} selected you as a guarantor for a loan of ₦${Number(amount).toLocaleString()}. Tap to review and respond.`,
        data: { token: verificationToken, loanId: createdLoan._id },
      })
    ),
  ]);

  return createdLoan;
};

/**
 * Replace a rejected guarantor with a new eligible guarantor.
 */
const replaceGuarantor = async ({ userId, loanId, oldGuarantorUserId, newGuarantorReferralCode, reason }) => {
  const loan = await LoanRepository.findById(loanId);
  if (!loan) throw new AppError("Loan not found.", 404);

  if (loan.userId.toString() !== userId.toString()) {
    throw new AppError("You are not authorized to modify this loan application.", 403);
  }

  if (loan.status !== "waiting_guarantor") {
    throw new AppError("Guarantor replacement is only allowed while the loan is waiting for guarantors.", 400);
  }

  const oldGuarantorIndex = loan.guarantors.findIndex(
    (g) => g.userId.toString() === oldGuarantorUserId.toString() && !g.isReplaced
  );

  if (oldGuarantorIndex === -1) {
    throw new AppError("Active guarantor to replace was not found on this loan.", 404);
  }

  const oldGuarantorEntry = loan.guarantors[oldGuarantorIndex];
  if (oldGuarantorEntry.status !== "rejected" && oldGuarantorEntry.status !== "expired") {
    throw new AppError("You can only replace a guarantor whose request was rejected or expired.", 400);
  }

  const newGuarantorCode = (newGuarantorReferralCode || "").trim().toUpperCase();
  const newGuarantorUser = await LoanRepository.findUserByReferralCode(newGuarantorCode);
  if (!newGuarantorUser) {
    throw new AppError(`New guarantor with referral code ${newGuarantorCode} was not found.`, 404);
  }

  if (newGuarantorUser._id.toString() === userId.toString()) {
    throw new AppError("You cannot select yourself as a guarantor.", 400);
  }

  // Prevent selecting someone already attached as active guarantor on this loan
  const alreadyOnLoan = loan.guarantors.some(
    (g) => !g.isReplaced && g.userId.toString() === newGuarantorUser._id.toString()
  );
  if (alreadyOnLoan) {
    throw new AppError(`${newGuarantorUser.fullName} is already selected as a guarantor for this loan.`, 400);
  }

  // Validate new guarantor eligibility
  const gNetSavings = await getNetSavings(newGuarantorUser._id);
  if (gNetSavings < 70000) {
    throw new AppError(`${newGuarantorUser.fullName} does not meet the minimum savings requirement of ₦70,000.`, 400);
  }

  const requiredGuarantorSavings = loan.principalAmount * 0.25;
  if (gNetSavings <= requiredGuarantorSavings) {
    throw new AppError(
      `${newGuarantorUser.fullName}'s savings (₦${gNetSavings.toLocaleString()}) must be greater than 25% of the loan amount (₦${requiredGuarantorSavings.toLocaleString()}).`,
      400
    );
  }

  if (!(await checkSavingsConsistency(newGuarantorUser._id))) {
    throw new AppError(`${newGuarantorUser.fullName} has not maintained consistent monthly savings.`, 400);
  }

  const activeStatuses = ["waiting_guarantor", "pending_review", "active", "warning_30_days", "defaulted_60_days"];
  const activeGuarantee = await LoanRepository.findActiveGuaranteeForGuarantor(newGuarantorUser._id, activeStatuses);
  if (activeGuarantee) {
    throw new AppError(`${newGuarantorUser.fullName} is already serving as an active guarantor on another loan.`, 400);
  }

  const verificationToken = crypto.randomBytes(32).toString("hex");
  const tokenExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const now = new Date();

  const session = await mongoose.startSession();
  let updatedLoan;

  try {
    await session.withTransaction(async () => {
      // 1. Mark old standalone guarantor record as isReplaced
      const oldGuarantorDoc = await LoanRepository.findGuarantorDocument(
        { loanId: loan._id, guarantorUserId: oldGuarantorUserId, isReplaced: false },
        session
      );
      if (oldGuarantorDoc) {
        oldGuarantorDoc.isReplaced = true;
        await LoanRepository.saveGuarantor(oldGuarantorDoc, session);
      }

      // 2. Mark old embedded guarantor entry as isReplaced
      oldGuarantorEntry.isReplaced = true;
      oldGuarantorEntry.replacedBy = newGuarantorUser._id;
      oldGuarantorEntry.replacementReason = reason || "Replaced by borrower after rejection";
      oldGuarantorEntry.replacedAt = now;

      // 3. Create new standalone Guarantor document
      const newGuarantorDoc = await LoanRepository.createGuarantorDocument(
        {
          loanId: loan._id,
          applicantId: userId,
          guarantorUserId: newGuarantorUser._id,
          guarantorName: newGuarantorUser.fullName,
          guarantorEmail: newGuarantorUser.email,
          guarantorPhone: newGuarantorUser.phone || "Not provided",
          relationship: "cooperative member",
          guaranteedAmount: loan.totalRepayable,
          remainingGuaranteedBalance: loan.totalRepayable,
          verificationToken,
          tokenExpiresAt,
          status: "pending",
          isReplaced: false,
          replacementFor: oldGuarantorDoc?._id || null,
        },
        session
      );

      // 4. Append new guarantor into embedded array
      loan.guarantors.push({
        userId: newGuarantorUser._id,
        fullName: newGuarantorUser.fullName,
        email: newGuarantorUser.email,
        phone: newGuarantorUser.phone,
        referralCode: newGuarantorUser.referralCode,
        status: "pending",
        verificationToken,
        guaranteedAmount: loan.totalRepayable,
        remainingGuaranteedBalance: loan.totalRepayable,
        requestedAt: now,
        isReplaced: false,
      });

      // 5. Check if all 4 active guarantors are accepted
      const activeGuarantors = loan.guarantors.filter((g) => !g.isReplaced);
      if (activeGuarantors.length === 4 && activeGuarantors.every((g) => g.status === "accepted")) {
        loan.status = "pending_review";
      }

      await LoanRepository.saveLoan(loan, session);
      updatedLoan = loan;
    });
  } finally {
    await session.endSession();
  }

  const borrowerUser = await LoanRepository.findUserById(userId);
  await createNotification({
    userId: newGuarantorUser._id,
    type: "loan",
    title: "Loan Guarantee Request",
    message: `${borrowerUser.fullName} selected you as a replacement guarantor for loan ₦${loan.principalAmount.toLocaleString()}. Tap to review.`,
    data: { token: verificationToken, loanId: loan._id },
  });

  return updatedLoan;
};

const approveAndDisburseLoan = async ({ loanId, adminUser }) => {
  const session = await mongoose.startSession();
  let loan;
  let activeGuarantors;
  try {
    await session.withTransaction(async () => {
      loan = await LoanRepository.findById(loanId, session);
      if (!loan) throw new AppError("Loan not found.", 404);

      if (loan.status !== "pending_review") {
        throw new AppError("Loan is not awaiting admin approval.", 400);
      }

      activeGuarantors = loan.guarantors?.filter((g) => !g.isReplaced) || [];
      if (activeGuarantors.length !== 4 || !activeGuarantors.every((g) => g.status === "accepted")) {
        throw new AppError("All 4 guarantors must accept this loan before approval.", 400);
      }

      const disbursementAmount = loan.principalAmount - loan.interestAmount;
      const disbursedAt = new Date();
      const installmentAmount = Math.floor(loan.totalRepayable / loan.durationMonths);
      const installments = [];
      let allocated = 0;

      for (let i = 1; i <= loan.durationMonths; i++) {
    let amountDue = installmentAmount;
    if (i === loan.durationMonths) {
      amountDue = loan.totalRepayable - allocated;
    }
    allocated += amountDue;

    const dueDate = new Date(disbursedAt);
    dueDate.setMonth(dueDate.getMonth() + i);

    installments.push({
      installmentNumber: i,
      dueDate,
      amountDue,
      amountPaid: 0,
      status: "unpaid",
      penaltyApplied: false,
    });
      }

      loan.status = "active";
  loan.disbursementAmount = disbursementAmount;
  loan.disbursedAt = disbursedAt;
  loan.approvedAt = new Date();
  loan.reviewedAt = new Date();
  loan.approvedBy = adminUser._id;
  loan.payoutStatus = "completed";
  loan.payoutReference = `PAYOUT-${Date.now()}`;
  loan.installments = installments;
  loan.amountPaid = 0;
  loan.remainingBalance = loan.totalRepayable;

      activeGuarantors.forEach((g) => {
    g.status = "active";
    g.remainingGuaranteedBalance = loan.remainingBalance || loan.totalRepayable;
      });

      await LoanRepository.saveLoan(loan, session);

      await FinancialLedgerService.recordEntry({
    entryType: "outflow",
    accountCategory: "loan_principal_receivable",
    activityType: "loan_disbursement",
    amount: disbursementAmount,
    reference: loan.payoutReference,
    userId: loan.userId,
    relatedId: loan._id,
    relatedModel: "Loans",
    notes: `Disbursed loan ${loan.loanNumber} to member`,
        session,
      });

  // Financial Ledger: Record Recognized Interest Inflow Revenue
      if (loan.interestAmount > 0) {
        await FinancialLedgerService.recordEntry({
      entryType: "inflow",
      accountCategory: "loan_interest_revenue",
      activityType: "loan_repayment_interest",
      amount: loan.interestAmount,
      reference: `INT_${loan.loanNumber}`,
      userId: loan.userId,
      relatedId: loan._id,
      relatedModel: "Loans",
      notes: `Upfront interest revenue for loan ${loan.loanNumber}`,
          session,
        });
      }
    });
  } finally {
    await session.endSession();
  }

  const guarantorUserIds = activeGuarantors.map((g) => g.userId);

  await Promise.all([
    createNotification({
      userId: loan.userId,
      type: "loan",
      title: "Loan Approved & Disbursed",
      message: `Congratulations! Your loan of ₦${loan.principalAmount.toLocaleString()} has been approved.`,
    }),
    ...guarantorUserIds.map((gId) =>
      createNotification({
        userId: gId,
        type: "guarantor",
        title: "Guarantee Activated",
        message: `The loan you guaranteed for ${loan.loanNumber} has been approved and is now active.`,
      })
    ),
  ]);

  return loan;
};

const processLoanRepayment = async ({
  loanId,
  transactionId,
  paymentAmount,
  paymentReference,
  paymentMethod = "flutterwave",
}) => {
  const session = await mongoose.startSession();
  let updatedLoan;
  let totalPenalty = 0;
  let wasDuplicate = false;

  try {
    await session.withTransaction(async () => {
      const loan = await LoanRepository.findById(loanId, session);
      if (!loan) throw new AppError("Loan not found.", 404);

      const payment = Number(paymentAmount);
      if (isNaN(payment) || payment <= 0) throw new AppError("Invalid payment amount.", 400);

      const allowedStatuses = ["active", "warning_30_days", "defaulted_60_days", "restricted_90_days", "recovery_120_days"];
      if (!allowedStatuses.includes(loan.status)) {
        throw new AppError("Loan is not active or eligible for repayment.", 400);
      }

      const alreadyProcessed = (loan.repaymentHistory || []).some(
        (r) => String(r.transactionId) === String(transactionId) || (r.reference && r.reference === paymentReference)
      );
      if (alreadyProcessed) {
        updatedLoan = loan;
        wasDuplicate = true;
        return;
      }

      const settings = await getSystemSettings();
      const latePenaltyRate = settings.latePenaltyRate || LATE_PENALTY_RATE;
      const now = new Date();

      for (const installment of loan.installments) {
        if (
          installment.status !== "paid" &&
          !installment.penaltyApplied &&
          installment.dueDate &&
          new Date(installment.dueDate) < now
        ) {
          installment.status = "overdue";
          const overdueAmount = installment.amountDue - installment.amountPaid;
          const penalty = Math.round(overdueAmount * (latePenaltyRate / 100));
          totalPenalty += penalty;
          installment.penaltyApplied = true;
        }
      }

      if (totalPenalty > 0) {
        loan.totalRepayable = Math.round(loan.totalRepayable + totalPenalty);
        loan.remainingBalance = Math.round(loan.remainingBalance + totalPenalty);
      }

      loan.amountPaid += payment;
      loan.remainingBalance = Math.max(0, loan.totalRepayable - loan.amountPaid);

      let remainingPayment = payment;
      for (const installment of loan.installments) {
        if (installment.status !== "paid" && remainingPayment > 0) {
          const amountNeeded = installment.amountDue - installment.amountPaid;
          if (remainingPayment >= amountNeeded) {
            installment.amountPaid = installment.amountDue;
            installment.status = "paid";
            installment.paidAt = new Date();
            remainingPayment -= amountNeeded;
          } else {
            installment.amountPaid += remainingPayment;
            installment.status = "partially_paid";
            remainingPayment = 0;
          }
        }
      }

      if (loan.remainingBalance <= 0) {
        loan.status = "completed";
        loan.completedAt = new Date();
        if (Array.isArray(loan.guarantors)) {
          loan.guarantors.forEach((g) => {
            if (!g.isReplaced) {
              g.status = "released";
              g.remainingGuaranteedBalance = 0;
            }
          });
        }
      } else {
        loan.status = "active";
      }

      loan.lastPaymentAt = new Date();
      loan.repaymentHistory.push({
        amount: payment,
        method: paymentMethod,
        reference: paymentReference,
        transactionId,
        paidAt: new Date(),
      });

      await LoanRepository.saveLoan(loan, session);

      const repaymentTransaction = await LoanRepository.findSavings(
        { reference: paymentReference, type: "loan_repayment" },
        session
      );
      if (repaymentTransaction) {
        repaymentTransaction.status = "completed";
        repaymentTransaction.amount = payment;
        repaymentTransaction.transactionId = transactionId;
        repaymentTransaction.loanId = loan._id;
        await repaymentTransaction.save({ session });
      } else {
        await LoanRepository.createSavingsRecord(
          {
            userId: loan.userId,
            amount: payment,
            type: "loan_repayment",
            method: paymentMethod,
            status: "completed",
            reference: paymentReference,
            transactionId,
            loanId: loan._id,
          },
          session
        );
      }

      await FinancialLedgerService.recordEntry({
        entryType: "inflow",
        accountCategory: "loan_principal_receivable",
        activityType: "loan_repayment_principal",
        amount: payment,
        reference: paymentReference,
        userId: loan.userId,
        relatedId: loan._id,
        relatedModel: "Loans",
        notes: `Repayment received for loan ${loan.loanNumber}`,
        session,
      });

      updatedLoan = loan;
    });
  } finally {
    await session.endSession();
  }

  if (wasDuplicate) return updatedLoan;

  await updateUserScore(updatedLoan.userId, "loan_repayment");
  await logAudit({
    userId: updatedLoan.userId,
    action: "loan_repayment",
    targetType: "loan",
    targetId: updatedLoan._id,
    details: {
      paymentAmount,
      transactionId,
      reference: paymentReference,
      remainingBalance: updatedLoan.remainingBalance,
      penaltyApplied: totalPenalty,
      completed: updatedLoan.status === "completed",
    },
  });

  let message = `Loan repayment of ₦${Number(paymentAmount).toLocaleString()} received successfully.`;
  if (totalPenalty > 0) message += ` ₦${totalPenalty.toLocaleString()} late penalty applied.`;
  if (updatedLoan.status === "completed") message += " Congratulations! Your loan has been fully repaid.";

  const notifications = [
    createNotification({
      userId: updatedLoan.userId,
      type: "loan",
      title: "Loan Repayment Successful",
      message,
    }),
  ];

  if (updatedLoan.status === "completed") {
    const activeGuarantorIds = updatedLoan.guarantors?.filter((g) => !g.isReplaced && g.userId).map((g) => g.userId) || [];
    activeGuarantorIds.forEach((gId) => {
      notifications.push(
        createNotification({
          userId: gId,
          type: "guarantor",
          title: "Guarantee Released",
          message: `The loan you guaranteed for ${updatedLoan.loanNumber} has been fully repaid. Your guarantee liability has been released.`,
        })
      );
    });
  }

  await Promise.all(notifications);
  return updatedLoan;
};

const initializeLoanRepayment = async ({ userId, userEmail, userName, userPhone, loanId, paymentAmount }) => {
  const loan = await LoanRepository.findOne({
    _id: loanId,
    userId,
    status: { $in: ["active", "warning_30_days", "defaulted_60_days", "restricted_90_days"] },
  });

  if (!loan) throw new AppError("No payable loan found.", 404);

  const amount = Math.round(Number(paymentAmount));
  if (isNaN(amount) || amount <= 0) throw new AppError("Invalid repayment amount.", 400);

  const tx_ref = `LRP_${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

  await LoanRepository.createSavingsRecord({
    userId,
    loanId: loan._id,
    amount,
    type: "loan_repayment",
    method: "flutterwave",
    status: "pending",
    reference: tx_ref,
  });

  return {
    publicKey: FLW_PUBLIC_KEY,
    public_key: FLW_PUBLIC_KEY,
    reference: tx_ref,
    tx_ref,
    txRef: tx_ref,
    amount,
    currency: "NGN",
    customer: {
      email: userEmail,
      name: userName,
      phone_number: userPhone || "",
    },
    customizations: {
      title: "SocketMonnie Loan Repayment",
      description: `Repayment for Loan ${loan.loanNumber || loan._id}`,
      logo: process.env.APP_LOGO || "",
    },
    meta: {
      paymentType: "loan_repayment",
      loanId: loan._id.toString(),
      userId: userId.toString(),
    },
    metadata: {
      paymentType: "loan_repayment",
      loanId: loan._id.toString(),
      userId: userId.toString(),
    },
    redirect_url: `${process.env.FRONTEND_URL || process.env.CLIENT_URL || ""}/loan/payment/callback`,
    // Split-payment subaccount — present ONLY in this one-time checkout payload.
    subaccount_id: FLW_SUBACCOUNT_ID || undefined,
  };
};

const verifyLoanRepayment = async ({ userId, loanId, reference, tx_ref, transactionId, transaction_id }) => {
  const txId = transaction_id || transactionId || null;
  const paymentRef = tx_ref || reference || null;
  if (!loanId || (!paymentRef && !txId)) throw new AppError("loanId and reference are required.", 400);

  const verification =
    txId && /^\d+$/.test(String(txId).trim())
      ? await verifyTransactionById(String(txId).trim())
      : await verifyPayment(paymentRef);
  if (!verification || verification.status !== "success") {
    throw new AppError("Unable to verify payment.", 400);
  }

  const payment = verification.data;
  const paymentStatus = (payment.status || "").trim().toLowerCase();
  if (!["completed", "success", "successful"].includes(paymentStatus)) {
    throw new AppError(`Payment not successful. Status: ${payment.status}`, 400);
  }
  if (String(payment.currency || "NGN").toUpperCase() !== "NGN") {
    throw new AppError("Currency mismatch.", 400);
  }

  const paymentReference = (payment.tx_ref || payment.reference || "").trim();
  if (!paymentReference || !["LRP_", "RPL_"].some((prefix) => paymentReference.startsWith(prefix))) {
    throw new AppError("Invalid loan repayment reference.", 400);
  }

  if (paymentRef && paymentReference !== String(paymentRef).trim()) {
    throw new AppError("Payment reference mismatch.", 400);
  }

  // Ownership: FLW meta carries the loanId/userId bound at initialization.
  const metaLoanId = String(payment?.meta?.loanId || payment?.metadata?.loanId || "");
  const metaUserId = String(payment?.meta?.userId || payment?.metadata?.userId || "");
  if (metaLoanId && metaLoanId !== String(loanId)) {
    throw new AppError("This transaction does not belong to this loan.", 403);
  }
  if (metaUserId && metaUserId !== String(userId)) {
    throw new AppError("This transaction does not belong to your account.", 403);
  }

  const loan = await LoanRepository.findOne({
    _id: loanId,
    userId,
    status: { $in: ["active", "warning_30_days"] },
  });
  if (!loan) throw new AppError("Loan not found.", 404);

  const paymentAmount = Number(payment.charged_amount ?? payment.amount_settled ?? payment.amount);
  if (!paymentAmount || paymentAmount <= 0) throw new AppError("Invalid payment amount.", 400);

  await LoanRepository.updateSavings(
    { reference: paymentReference, type: "loan_repayment", status: "pending" },
    { $set: { status: "completed", transactionId: String(payment.id), amount: paymentAmount } }
  );

  return await processLoanRepayment({
    loanId: loan._id,
    transactionId: String(payment.id || paymentRef),
    paymentAmount,
    paymentReference,
    paymentMethod: "flutterwave",
    verifiedData: payment,
  });
};

const triggerLoanDefaulterCheck = async () => {
  const result = await runLoanDefaulterEscalation();
  return result.summary;
};

const LoanService = {
  getEligibility,
  getActiveLoan,
  getById,
  getSchedule,
  getHistory,
  applyForLoan,
  replaceGuarantor,
  approveAndDisburseLoan,
  initializeLoanRepayment,
  verifyLoanRepayment,
  processLoanRepayment,
  triggerLoanDefaulterCheck,
};

module.exports = { LoanService, processLoanRepayment };