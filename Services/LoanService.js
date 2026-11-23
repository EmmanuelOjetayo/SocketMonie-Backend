const { startSafeSession } = require("../Utilis/transactionRunner");
const crypto = require("crypto");
const { LoanRepository } = require("../Repositories/LoanRepository");
const { InterestCalculationService } = require("./InterestCalculationService");
const { FinancialLedgerService } = require("./FinancialLedgerService");
const { SavingsService } = require("./SavingsService");
const { createNotification } = require("../Utilis/notificationHelper");
const { updateUserScore } = require("../Utilis/scoreService");
const { logAudit } = require("../Utilis/auditLogger");
const { FLW_PUBLIC_KEY, FLW_SUBACCOUNT_ID } = require("../Utilis/Flutterwave");
const { runLoanDefaulterEscalation } = require("../Utilis/loanDefaulterEngine");
const { computeMonthlyQualification } = require("../Utilis/savingsQualification");
const AppError = require("../Utilis/AppError");
const {
  GUARANTOR_MIN_SAVINGS,
  GUARANTOR_MIN_PERCENTAGE,
  LATE_PENALTY_RATE,
  LOAN_TIERS,
  INTEREST_RATES,
  ELIGIBILITY,
} = require("../Config/constants");

const getNetSavings = async (userId) => {
  const completedSavings = await LoanRepository.findCompletedSavings(userId);
  return completedSavings.reduce((sum, item) => {
    if (item.type === "withdrawal") return sum - item.amount;
    if (item.type === "deposit") return sum + item.amount;
    return sum;
  }, 0);
};

const getMonthlyQualificationSummary = async (userId, settings) => {
  const records = await LoanRepository.findCompletedSavings(userId);
  const minMonthlyRequired =
    Number(settings?.eligibility?.minMonthlySavings) ||
    Number(process.env.MIN_MONTHLY_SAVINGS) ||
    undefined;
  return computeMonthlyQualification({
    records,
    minimumMonthlyRequired,
    now: new Date(),
    windowMonths: Number(settings?.eligibility?.minMonths) || 6,
  });
};

const checkSavingsConsistency = async (userId) => {
  const settings = await getSystemSettings();
  const qualification = await getMonthlyQualificationSummary(userId, settings);
  return qualification.isConsistent;
};

const countSavingsMonths = async (userId) => {
  const settings = await getSystemSettings();
  const qualification = await getMonthlyQualificationSummary(userId, settings);
  return qualification.qualifyingMonths;
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

  const [netSavings, qualification, completedRegularLoansCount] = await Promise.all([
    getNetSavings(userId),
    getMonthlyQualificationSummary(userId, settings),
    LoanRepository.count({ userId, status: "completed", loanType: { $ne: "emergency" } }),
  ]);

  const isConsistent = qualification.isConsistent;
  const monthsCount = qualification.qualifyingMonths;

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
    minMonthlySavings: qualification.minimumMonthlyRequired,
    isEmergency,
    monthlyQualification: {
      minimumMonthlyRequired: qualification.minimumMonthlyRequired,
      windowMonths: qualification.windowMonths,
      qualifyingMonths: qualification.qualifyingMonths,
      isConsistent: qualification.isConsistent,
      months: qualification.months,
    },
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

  // Terms & Conditions / Privacy Policy acceptance is mandatory before applying.
  if (!user || user.termsAccepted !== true || user.privacyAccepted !== true) {
    throw new AppError("You must accept the Socket Monie Terms and Conditions and Privacy Policy before applying for a loan.", 403);
  }

  // BUSINESS RULE: Fixed 2% upfront interest. Calculated at request time on
  // the requested amount, then collected UPFRONT by deducting it from the
  // loan proceeds at payout. It is NOT added to the repayment obligation —
  // the member repays the approved principal only.
  //   requested = ₦100,000 → interest = ₦2,000 → payout = ₦98,000 → repay ₦100,000
  const interestCalc = await InterestCalculationService.calculateInterest({
    loanType,
    userTier: user.tier || "Bronze",
    socketScore: user.socketScore || 0,
    principalAmount: Number(amount),
  });

  const interestRate = interestCalc.interestRate;
  const interestAmount = interestCalc.interestAmount;
  const totalRepayable = Number(amount);
  const disbursementAmount = Number(amount) - interestAmount;
  // Each of the four guarantors is liable for at most 25% of the original
  // approved principal. The principal is the repayable amount under the fixed
  // 2% upfront-interest model.
  const guarantorLiability = Math.round(totalRepayable * 0.25 * 100) / 100;

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

    if (gNetSavings < requiredGuarantorSavings) {
      throw new AppError(
        `${guarantor.fullName}'s savings (₦${gNetSavings.toLocaleString()}) must be at least 25% of the loan amount (₦${requiredGuarantorSavings.toLocaleString()}).`,
        400
      );
    }

    guarantors.push({
      user: guarantor,
      verificationToken: crypto.randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
  }

  const session = await startSafeSession();
  let createdLoan;
  try {
    await session.withTransaction(async () => {
      // Concurrency guard: touch the member doc inside the transaction (creates
      // a write conflict that serializes concurrent applications) and re-check
      // for an active loan inside the transaction before inserting (P0 item 18).
      await LoanRepository.touchMemberForApplicationLock(userId, session);
      const existingLoan = await LoanRepository.findActiveForUser(userId, session);
      if (existingLoan) {
        let message = "You already have an active or processing loan.";
        if (existingLoan.status === "waiting_guarantor") {
          message = "You have a loan application awaiting guarantor approval.";
        } else if (existingLoan.status === "pending_review") {
          message = "You already have a loan awaiting admin approval.";
        }
        throw new AppError(message, 400);
      }

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
          guaranteedAmount: guarantorLiability,
          remainingGuaranteedBalance: guarantorLiability,
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
        guaranteedAmount: guarantorLiability,
        remainingGuaranteedBalance: guarantorLiability,
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
/**
 * Withdraw (cancel) a loan application that is still awaiting guarantors.
 * This is the guaranteed exit from "waiting_guarantor": without it a member
 * whose guarantors never respond could be permanently blocked from applying
 * again (findActiveForUser keeps counting waiting_guarantor applications).
 * The loan is marked "withdrawn" (not "rejected" — admin rejection is a
 * separate review decision), pending guarantor requests are closed, and all
 * non-replaced guarantors are notified that the request is void.
 */
const cancelApplication = async ({ userId, loanId, reason }) => {
  const session = await startSafeSession();
  let cancelledLoan;

  try {
    await session.withTransaction(async () => {
      const loan = await LoanRepository.findById(loanId, session);
      if (!loan) throw new AppError("Loan not found.", 404);

      if (loan.userId.toString() !== userId.toString()) {
        throw new AppError("You are not authorized to cancel this loan application.", 403);
      }

      if (loan.status !== "waiting_guarantor") {
        throw new AppError("Only a loan application that is still awaiting guarantors can be withdrawn.", 400);
      }

      loan.status = "withdrawn";
      loan.rejectionReason = reason || "Withdrawn by applicant";
      loan.reviewedAt = new Date();

      // Close every still-pending guarantor request (standalone docs + embedded).
      for (const guarantor of loan.guarantors || []) {
        if (!guarantor.isReplaced && ["pending", "waiting_guarantor"].includes(guarantor.status)) {
          guarantor.status = "expired";
        }
      }
      await LoanRepository.saveLoan(loan, session);
      await LoanRepository.expirePendingGuarantorRequests(loan._id, session);

      cancelledLoan = loan;
    });
  } finally {
    await session.endSession();
  }

  const notifyTargets = (cancelledLoan.guarantors || [])
    .filter((g) => !g.isReplaced && g.userId)
    .map((g) => g.userId);

  await Promise.all(
    notifyTargets.map((guarantorId) =>
      createNotification({
        userId: guarantorId,
        type: "loan",
        title: "Guarantee Request Withdrawn",
        message: `${cancelledLoan.loanNumber} was withdrawn by the applicant. Your guarantee request is closed — no action is needed.`,
        data: { loanId: cancelledLoan._id, loanNumber: cancelledLoan.loanNumber, status: "withdrawn" },
      })
    )
  );

  await logAudit({
    userId,
    action: "loan_withdraw",
    targetType: "loan",
    targetId: cancelledLoan._id,
    details: {
      loanNumber: cancelledLoan.loanNumber,
      principalAmount: cancelledLoan.principalAmount,
      reason: cancelledLoan.rejectionReason,
    },
  });

  return cancelledLoan;
};

const replaceGuarantor = async ({ userId, loanId, oldGuarantorUserId, newGuarantorReferralCode, reason }) => {
  const loan = await LoanRepository.findById(loanId);
  if (!loan) throw new AppError("Loan not found.", 404);
  const guarantorLiability =
    Math.round(Number(loan.totalRepayable || 0) * 0.25 * 100) / 100;

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
  if (gNetSavings < requiredGuarantorSavings) {
    throw new AppError(
      `${newGuarantorUser.fullName}'s savings (₦${gNetSavings.toLocaleString()}) must be at least 25% of the loan amount (₦${requiredGuarantorSavings.toLocaleString()}).`,
      400
    );
  }

  if (!(await checkSavingsConsistency(newGuarantorUser._id))) {
    throw new AppError(`${newGuarantorUser.fullName} has not maintained consistent monthly savings.`, 400);
  }

  const activeStatuses = ["waiting_guarantor", "pending_review", "active", "warning_30_days", "defaulted_60_days", "restricted_90_days", "recovery_120_days"];
  const activeGuarantee = await LoanRepository.findActiveGuaranteeForGuarantor(newGuarantorUser._id, activeStatuses);
  if (activeGuarantee) {
    throw new AppError(`${newGuarantorUser.fullName} is already serving as an active guarantor on another loan.`, 400);
  }

  const verificationToken = crypto.randomBytes(32).toString("hex");
  const tokenExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const now = new Date();

  const session = await startSafeSession();
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
          guaranteedAmount: guarantorLiability,
          remainingGuaranteedBalance: guarantorLiability,
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
        guaranteedAmount: guarantorLiability,
        remainingGuaranteedBalance: guarantorLiability,
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

const buildLoanInstallments = (loan, disbursedAt = new Date()) => {
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
  return installments;
};

const finalizeManualLoanDisbursement = async ({ loanId, adminUser }) => {
  const session = await startSafeSession();
  let loan;
  let guarantorUserIds = [];
  try {
    await session.withTransaction(async () => {
      loan = await LoanRepository.findById(loanId, session);
      if (!loan) throw new AppError("Loan not found.", 404);

      if (loan.status === "active" && loan.payoutStatus === "completed") {
        guarantorUserIds = (loan.guarantors || []).filter((g) => !g.isReplaced).map((g) => g.userId);
        return;
      }
      if (loan.status !== "pending_review") {
        throw new AppError("Loan is not awaiting admin approval.", 400);
      }

      // Separation of duties
      if (adminUser?._id && String(loan.userId) === String(adminUser._id)) {
        throw new AppError("You cannot approve your own loan application.", 403);
      }

      const activeGuarantors = (loan.guarantors || []).filter((g) => !g.isReplaced);
      if (activeGuarantors.length !== 4 || !activeGuarantors.every((g) => g.status === "accepted")) {
        throw new AppError("All 4 guarantors must accept this loan before approval.", 400);
      }
      if (
        adminUser?._id &&
        activeGuarantors.some((g) => g.userId && String(g.userId) === String(adminUser._id))
      ) {
        throw new AppError("You cannot approve a loan in which you are a guarantor.", 403);
      }

      // Borrower's profile bank details are authoritative for admin review/manual payment.
      const borrower = await LoanRepository.findUserById(loan.userId);
      if (!borrower) throw new AppError("Borrower account not found.", 404);
      const bank = borrower.bankDetails || {};
      const bankCode = String(bank.bankCode || "").trim();
      const accountNumber = String(bank.accountNumber || "").replace(/\s+/g, "").trim();
      const accountName = String(bank.accountName || "").trim();
      if (!bankCode || !accountNumber) {
        throw new AppError("Borrower bank details are incomplete in profile. Update the member's bank details before confirming manual disbursement.", 400);
      }
      if (!/^\d{10}$/.test(accountNumber)) {
        throw new AppError("Borrower bank account number is invalid. A verified 10-digit account number is required before confirming manual disbursement.", 400);
      }

      const disbursementAmount = Number(loan.principalAmount) - Number(loan.interestAmount || 0);
      if (!Number.isFinite(disbursementAmount) || disbursementAmount <= 0) {
        throw new AppError("Invalid disbursement amount.", 400);
      }
      if (Math.round(disbursementAmount + Number(loan.interestAmount || 0)) !== Math.round(Number(loan.principalAmount || 0))) {
        throw new AppError("Loan financial values are inconsistent. Disbursement cannot proceed.", 400);
      }

      const disbursedAt = new Date();
      const manualReference = loan.payoutReference || `MANUAL_${loan.loanNumber || loan._id}_${Date.now()}`;

      loan.status = "active";
      loan.approvedAt = loan.approvedAt || disbursedAt;
      loan.reviewedAt = disbursedAt;
      loan.approvedBy = adminUser._id;
      loan.disbursedBy = adminUser._id;
      loan.disbursedAt = disbursedAt;
      loan.disbursementAmount = disbursementAmount;
      loan.payoutStatus = "completed";
      loan.payoutReference = manualReference;
      loan.payoutRef = manualReference; // manual confirmation reference (not an external provider transfer id)
      loan.payoutInitiatedAt = null;
      loan.payoutFailedAt = null;
      loan.payoutFailureReason = null;
      loan.payoutProviderResponse = { mode: "manual", confirmedBy: adminUser._id, confirmedAt: disbursedAt };
      loan.disbursementBankDetails = {
        bankCode,
        bankName: bank.bankName || null,
        accountNumber,
        accountName: accountName || borrower.fullName || null,
      };
      loan.installments = buildLoanInstallments(loan, disbursedAt);
      loan.amountPaid = loan.amountPaid || 0;
      loan.remainingBalance = loan.totalRepayable;

      activeGuarantors.forEach((g) => {
        g.status = "active";
        g.remainingGuaranteedBalance = loan.remainingBalance || loan.totalRepayable;
      });
      guarantorUserIds = activeGuarantors.map((g) => g.userId);

      await LoanRepository.saveLoan(loan, session);

      await FinancialLedgerService.recordEntry({
        entryType: "outflow",
        accountCategory: "loan_principal_receivable",
        activityType: "loan_disbursement",
        amount: disbursementAmount,
        reference: manualReference,
        eventKey: `loan_manual_disbursement:${loan._id}:${manualReference}`,
        userId: loan.userId,
        relatedId: loan._id,
        relatedModel: "Loans",
        notes: `Manual disbursement confirmed by admin for loan ${loan.loanNumber} (₦${Number(loan.principalAmount).toLocaleString()} principal, ₦${Number(loan.interestAmount || 0).toLocaleString()} upfront interest, ₦${Number(disbursementAmount).toLocaleString()} net disbursed).`,
        session,
      });

      if (loan.interestAmount > 0) {
        await FinancialLedgerService.recordEntry({
          entryType: "inflow",
          accountCategory: "loan_interest_revenue",
          activityType: "loan_repayment_interest",
          amount: loan.interestAmount,
          reference: `INT_${loan.loanNumber}`,
          eventKey: `loan_interest_revenue:${loan._id}:${manualReference}`,
          userId: loan.userId,
          relatedId: loan._id,
          relatedModel: "Loans",
          notes: `Upfront interest revenue recognized on manually confirmed disbursement for loan ${loan.loanNumber}`,
          session,
        });
      }
    });
  } finally {
    await session.endSession();
  }

  if (loan?.status === "active" && loan?.payoutStatus === "completed") {
    await Promise.all([
      createNotification({
        userId: loan.userId,
        type: "loan",
        title: "Loan Approved & Disbursement Confirmed",
        message: `Your loan ${loan.loanNumber} has been approved. A manual disbursement of ₦${Number(loan.disbursementAmount || 0).toLocaleString()} has been confirmed by admin. Your repayment schedule is now active.`,
      }),
      ...guarantorUserIds.map((gId) =>
        createNotification({
          userId: gId,
          type: "guarantor",
          title: "Guarantee Activated",
          message: `The loan you guaranteed for ${loan.loanNumber} has been approved and disbursement has been confirmed. The guarantee is now active.`,
        })
      ),
    ]);

    await logAudit({
      userId: adminUser._id,
      userEmail: adminUser.email,
      userRole: adminUser.role,
      action: "loan_manual_disbursement_confirmed",
      targetType: "loan",
      targetId: loan._id,
      details: {
        loanNumber: loan.loanNumber,
        principalAmount: loan.principalAmount,
        interestAmount: loan.interestAmount,
        disbursementAmount: loan.disbursementAmount,
        totalRepayable: loan.totalRepayable,
        payoutReference: loan.payoutReference,
        disbursementMode: "manual",
        confirmedBy: adminUser._id,
        confirmedAt: loan.disbursedAt,
        guarantorIds: guarantorUserIds,
      },
    });
  }

  return loan;
};

// Backward-compatible export name used by controllers/routes.
const approveAndDisburseLoan = async ({ loanId, adminUser }) => {
  return finalizeManualLoanDisbursement({ loanId, adminUser });
};

const processLoanRepayment = async ({
  loanId,
  transactionId,
  paymentAmount,
  paymentReference,
  paymentMethod = "flutterwave",
}) => {
  const session = await startSafeSession();
  let updatedLoan;
  let totalPenalty = 0;
  let wasDuplicate = false;
  let excessAmount = 0;
  let appliedToLoan = 0;

  console.log(
    `[LOAN REPAYMENT WEBHOOK→SERVICE] received | loanId: ${loanId} | TX: ${transactionId} | ref: ${paymentReference} | amount: ${paymentAmount}`
  );

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
        console.log(`[LOAN REPAYMENT WEBHOOK→SERVICE] ✗ idempotent skip | loanId: ${loanId} | TX: ${transactionId} — already in repayment history`);
        return;
      }
      console.log(`[LOAN REPAYMENT WEBHOOK→SERVICE] ② loan found | status: ${loan.status} | remainingBalance: ${loan.remainingBalance} | installments: ${loan.installments?.length}`);

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

      // Overpayment handling (refund_review): apply only the valid outstanding
      // amount to the loan. Excess is recorded separately and flagged for admin
      // refund review — never silently discarded, never applied to another loan,
      // never treated as interest/revenue. (Owner decision: refund_review)
      appliedToLoan = payment;
      excessAmount = 0;
      if (payment > loan.remainingBalance) {
        appliedToLoan = loan.remainingBalance;
        excessAmount = Math.round(payment - loan.remainingBalance);
        console.log(
          `[LOAN REPAYMENT WEBHOOK→SERVICE] ⚠ overpayment detected | payment: ${payment} | outstanding: ${loan.remainingBalance} | applied: ${appliedToLoan} | excess(refund_review): ${excessAmount}`
        );
      }

      loan.amountPaid += appliedToLoan;
      loan.remainingBalance = Math.max(0, loan.totalRepayable - loan.amountPaid);

      let remainingPayment = appliedToLoan;
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
        amount: appliedToLoan,
        method: paymentMethod,
        reference: paymentReference,
        transactionId,
        paidAt: new Date(),
      });

      // Record excess for administrative refund review (not applied to loan).
      if (excessAmount > 0) {
        if (!Array.isArray(loan.overpaymentRefunds)) loan.overpaymentRefunds = [];
        loan.overpaymentRefunds.push({
          amount: excessAmount,
          status: "pending_review",
          reference: paymentReference,
          transactionId,
          recordedAt: new Date(),
        });
        // Ledger: record excess as a separate inflow (cash received, held pending refund).
        // Tracked distinctly from loan principal application; never treated as revenue.
        await FinancialLedgerService.recordEntry({
          entryType: "inflow",
          accountCategory: "cash_asset",
          activityType: "reversal_adjustment",
          amount: excessAmount,
          reference: `${paymentReference}_EXCESS`,
          eventKey: `overpayment_excess:${paymentReference}`,
          userId: loan.userId,
          relatedId: loan._id,
          relatedModel: "Loans",
          notes: `Overpayment excess (refund_review) for loan ${loan.loanNumber}. Not applied to balance. Awaiting admin refund action.`,
          session,
        });
      }

      await LoanRepository.saveLoan(loan, session);

      console.log(
        `[LOAN REPAYMENT WEBHOOK→SERVICE] ③ loan updated | loanId: ${loan._id} | userId: ${loan.userId} | amount: ${payment} | penalty: ${totalPenalty} | newBalance: ${loan.remainingBalance} | status: ${loan.status}`
      );

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
        amount: appliedToLoan,
        reference: paymentReference,
        userId: loan.userId,
        relatedId: loan._id,
        relatedModel: "Loans",
        notes: excessAmount > 0
          ? `Repayment applied to loan ${loan.loanNumber} (₦${appliedToLoan.toLocaleString()} of ₦${payment.toLocaleString()}; excess ₦${excessAmount.toLocaleString()} flagged for refund review)`
          : `Repayment received for loan ${loan.loanNumber}`,
        session,
      });

      updatedLoan = loan;
      console.log(
        `[LOAN REPAYMENT WEBHOOK→SERVICE] ✔ settled | loan ${loan._id} repaid — amount: ${payment} | remainingBalance: ${loan.remainingBalance} | status: ${loan.status}`
      );
    });
  } finally {
    await session.endSession();
  }

  if (wasDuplicate) {
    console.log(`[LOAN REPAYMENT WEBHOOK→SERVICE] ✗ finished | idempotent duplicate — loan state unchanged`);
    return updatedLoan;
  }

  await updateUserScore(updatedLoan.userId, "loan_repayment");
  console.log(
    `[LOAN REPAYMENT WEBHOOK→SERVICE] ✔ finished OK | userId: ${updatedLoan.userId} | loanId: ${updatedLoan._id} | amount: ${paymentAmount} — score + audit + notifications next`
  );
  await logAudit({
    userId: updatedLoan.userId,
    action: "loan_repayment",
    targetType: "loan",
    targetId: updatedLoan._id,
    details: {
      paymentAmount,
      appliedToLoan,
      excessAmount,
      transactionId,
      reference: paymentReference,
      remainingBalance: updatedLoan.remainingBalance,
      penaltyApplied: totalPenalty,
      completed: updatedLoan.status === "completed",
    },
  });

  let message = `Loan repayment of ₦${Number(paymentAmount).toLocaleString()} received successfully.`;
  if (totalPenalty > 0) message += ` ₦${totalPenalty.toLocaleString()} late penalty applied.`;
  if (excessAmount > 0) message += ` ₦${excessAmount.toLocaleString()} excess has been recorded for administrative refund review.`;
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

  // Recalculate guarantor recovery tracking after repayment (infrastructure only; no auto deductions).
  try {
    if (["warning_30_days", "defaulted_60_days", "restricted_90_days", "recovery_120_days", "active", "completed"].includes(updatedLoan.status)) {
      const { syncRecoveryObligations } = require("../Utilis/loanDefaulterEngine");
      await syncRecoveryObligations(updatedLoan);
    }
  } catch (recoveryErr) {
    console.error("[LOAN REPAYMENT] recovery obligation sync failed:", recoveryErr.message);
  }

  await Promise.all(notifications);
  return updatedLoan;
};

const initializeLoanRepayment = async ({ userId, userEmail, userName, userPhone, loanId, paymentAmount }) => {
  const loan = await LoanRepository.findOne({
    _id: loanId,
    userId,
    status: { $in: ["active", "warning_30_days", "defaulted_60_days", "restricted_90_days", "recovery_120_days"] },
  });

  if (!loan) throw new AppError("No payable loan found.", 404);

  const amount = Math.round(Number(paymentAmount));
  if (isNaN(amount) || amount <= 0) throw new AppError("Invalid repayment amount.", 400);

  // Reference shape (restored): `LRP_<ts>_<hex>_<userId[-6]>` — underscore
  // format REQUIRED because the webhook dispatcher (processWebhook) routes
  // by `reference.startsWith("LRP_")`/`"RPL_"`. Hyphen refs (fix 2) never
  // reached their handler. No browser callback settles a repayment.
  const tx_ref = `LRP_${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${userId
    .toString()
    .slice(-6)}`;

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
      // Working-project fallback (fix 1): never an empty phone —
      // Flutterwave telemetry 400s on empty customer fields.
      phone_number: userPhone || "08000000000",
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

const triggerLoanDefaulterCheck = async () => {
  const result = await runLoanDefaulterEscalation();
  return result.summary;
};

const finalizeLoanDisbursement = finalizeManualLoanDisbursement;

const LoanService = {
  getEligibility,
  getActiveLoan,
  getById,
  getSchedule,
  getHistory,
  applyForLoan,
  cancelApplication,
  replaceGuarantor,
  approveAndDisburseLoan,
  finalizeLoanDisbursement,
  finalizeManualLoanDisbursement,
  initializeLoanRepayment,
  processLoanRepayment,
  triggerLoanDefaulterCheck,
};

module.exports = { LoanService, processLoanRepayment, finalizeLoanDisbursement, finalizeManualLoanDisbursement };
