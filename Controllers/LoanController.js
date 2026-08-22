const Loan = require("../Models/LoanModel");
const Savings = require("../Models/SavingsModel");
const User = require("../Models/UserModel");
const SystemSettings = require("../Models/SystemSettingsModel");
const { createNotification } = require("../Utilis/notificationHelper");
const { getInterestRate } = require("../Utilis/tierService");
const { updateUserScore } = require("../Utilis/scoreService");
const { logAudit } = require("../Utilis/auditLogger");
const crypto = require("crypto");
const Guarantor = require("../Models/GuarantorModel"); // Adjust path to your Guarantor model
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY
// Helper: Calculate net completed savings
const getNetSavings = async (userId) => {
  const completedSavings = await Savings.find({ userId, status: "completed" });
  return completedSavings.reduce((sum, item) => {
    if (item.type === "withdrawal") return sum - item.amount;
    if (item.type === "deposit") return sum + item.amount;
    return sum;
  }, 0);
};

// Helper: Check if member saved at least ₦5,000 every month for the last 6 months
const checkSavingsConsistency = async (userId) => {
  const deposits = await Savings.find({
    userId,
    type: "deposit",
    status: "completed",
  }).sort({ createdAt: 1 });

  const monthlySavings = {};

  deposits.forEach((deposit) => {
    const date = new Date(deposit.createdAt);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

    monthlySavings[key] = (monthlySavings[key] || 0) + deposit.amount;
  });

  const today = new Date();
  const requiredMonths = [];

  // Last 6 calendar months (including current month)
  for (let i = 5; i >= 0; i--) {
    const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    requiredMonths.push(key);
  }

  // Every required month must have at least ₦5,000 deposited
  for (const month of requiredMonths) {
    const monthlyTotal = monthlySavings[month] || 0;

    if (monthlyTotal < 5000) {
      return false;
    }
  }

  return true;
};


// Helper: Count distinct total savings months
const countSavingsMonths = async (userId) => {
  const deposits = await Savings.find({
    userId,
    type: "deposit",
    status: "completed",
  });

  const monthsSet = new Set(
    deposits.map((d) => `${d.createdAt.getFullYear()}-${d.createdAt.getMonth()}`)
  );
  return monthsSet.size;
};

// Helper: Get or initialize system settings
const getSystemSettings = async () => {
  let settings = await SystemSettings.findOne();
  if (!settings) {
    settings = await SystemSettings.create({
      loanTiers: { firstLoan: 0.7, secondLoan: 1.0, thirdLoan: 1.5 },
      interestRates: { bronze: 10, silver: 8, gold: 6, platinum: 5 },
      eligibility: { minSavings: 70000, minMonths: 6 },
      withdrawalFee: 100,
      latePenaltyRate: 2,
    });
  }
  return settings;
};

// GET /api/loans/eligibility
exports.checkEligibility = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const settings = await getSystemSettings();

    const [
      netSavings,
      isConsistent,
      monthsCount,
      completedLoansCount,
    ] = await Promise.all([
      getNetSavings(userId),
      checkSavingsConsistency(userId),
      countSavingsMonths(userId),
      Loan.countDocuments({
        userId,
        status: "completed",
      }),
    ]);

    const { firstLoan, secondLoan, thirdLoan } = settings.loanTiers;

    let tierPercentage = firstLoan;
    let tierName = "1st_tier_70";

    if (completedLoansCount === 1) {
      tierPercentage = secondLoan;
      tierName = "2nd_tier_100";
    } else if (completedLoansCount >= 2) {
      tierPercentage = thirdLoan;
      tierName = "3rd_tier_150";
    }

    const meetsSavingsThreshold =
      netSavings >= settings.eligibility.minSavings;

    const isEligible =
      isConsistent &&
      meetsSavingsThreshold &&
      monthsCount >= settings.eligibility.minMonths;

    const maxLoanAmount = isEligible
      ? Math.round(netSavings * tierPercentage)
      : 0;

    return res.status(200).json({
      success: true,
      eligibility: {
        isEligible,
        isConsistent,
        meetsSavingsThreshold,
        netSavings,
        maxLoanAmount,
        tierName,
        completedLoansCount,
        monthsCount,
        minSavings: settings.eligibility.minSavings,
        minMonths: settings.eligibility.minMonths,
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/loans/active
exports.getActiveLoan = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const activeLoan = await Loan.findOne({
      userId,
      status: { $in: ["waiting_guarantor", "pending_review", "active", "warning_30_days"] },
    });
    return res.status(200).json({ success: true, loan: activeLoan || null });
  } catch (err) {
    next(err);
  }
};

// GET /api/loans/:loanId
exports.getLoanById = async (req, res, next) => {
  try {
    const loan = await Loan.findById(req.params.loanId);
    if (!loan) return res.status(404).json({ success: false, message: "Loan not found." });

    if (loan.userId.toString() !== req.user._id.toString() && req.user.role !== "super_admin") {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    return res.status(200).json({ success: true, loan });
  } catch (err) {
    next(err);
  }
};

// GET /api/loans/history
exports.getLoanHistory = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { status, page = 1, limit = 10 } = req.query;
    const filter = { userId };
    if (status) filter.status = status;

    const total = await Loan.countDocuments(filter);
    const loans = await Loan.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const stats = {
      totalLoans: total,
      completed: await Loan.countDocuments({ userId, status: "completed" }),
      active: await Loan.countDocuments({ userId, status: { $in: ["active", "warning_30_days"] } }),
      defaulted: await Loan.countDocuments({ userId, status: "defaulted_60_days" }),
    };

    return res.status(200).json({
      success: true,
      data: loans,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      stats,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/loans/:loanId/schedule
exports.getRepaymentSchedule = async (req, res, next) => {
  try {
    const loan = await Loan.findById(req.params.loanId);
    if (!loan) return res.status(404).json({ success: false, message: "Loan not found." });

    if (loan.userId.toString() !== req.user._id.toString() && req.user.role !== "super_admin") {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    return res.status(200).json({
      success: true,
      schedule: loan.installments || [],
      nextDue: loan.installments ? loan.installments.find((i) => i.status !== "paid") : null,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/loans/apply
exports.applyForLoan = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const {
      amount,
      durationMonths,
      loanType,
      disbursementMethod,
      purpose,
      guarantorReferralCodes,
    } = req.body;

    // =========================
    // Validate Request Body
    // =========================

    if (!amount || !durationMonths || !loanType) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields.",
      });
    }

    if (Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Loan amount must be greater than zero.",
      });
    }

    const referralCodes = Array.isArray(guarantorReferralCodes)
      ? guarantorReferralCodes.map((code) => String(code || "").trim().toUpperCase()).filter(Boolean)
      : [];

    if (referralCodes.length !== 3 || new Set(referralCodes).size !== 3) {
      return res.status(400).json({
        success: false,
        message: "Three different guarantor referral codes are required.",
      });
    }

    // =========================
    // Check Existing Borrower Loan
    // =========================

    const existingLoan = await Loan.findOne({
      userId,
      status: {
        $in: [
          "waiting_guarantor",
          "pending_review",
          "active",
          "warning_30_days",
          "defaulted_60_days",
          "restricted_90_days",
          "recovery_120_days",
        ],
      },
    });

    if (existingLoan) {
      let message = "You already have an active or processing loan.";
      if (existingLoan.status === "waiting_guarantor") {
        message = "You have a loan application awaiting guarantor approval.";
      } else if (existingLoan.status === "pending_review") {
        message = "You already have a loan awaiting admin approval.";
      }

      return res.status(400).json({
        success: false,
        message,
      });
    }

    // =========================
    // Load System & User Data
    // =========================

    const settings = await getSystemSettings();

    const [
      user,
      netSavings,
      isConsistent,
      monthsCount,
      completedLoansCount,
    ] = await Promise.all([
      User.findById(userId),
      getNetSavings(userId),
      checkSavingsConsistency(userId),
      countSavingsMonths(userId),
      Loan.countDocuments({
        userId,
        status: "completed",
      }),
    ]);

    // =========================
    // Check Borrower Eligibility
    // =========================

    if (
      !isConsistent ||
      monthsCount < settings.eligibility.minMonths ||
      netSavings < settings.eligibility.minSavings
    ) {
      return res.status(400).json({
        success: false,
        message: `You must save consistently for at least ${
          settings.eligibility.minMonths
        } months and maintain a minimum net savings of ₦${settings.eligibility.minSavings.toLocaleString()}.`,
      });
    }

    // =========================
    // Calculate Loan Tier & Max Cap
    // =========================

    const { firstLoan, secondLoan, thirdLoan } = settings.loanTiers;

    let tierPercentage = firstLoan;
    let tierName = "1st_tier_70";

    if (completedLoansCount === 1) {
      tierPercentage = secondLoan;
      tierName = "2nd_tier_100";
    } else if (completedLoansCount >= 2) {
      tierPercentage = thirdLoan;
      tierName = "3rd_tier_150";
    }

    const maxLoanAmount = Math.round(netSavings * tierPercentage);

    if (Number(amount) > maxLoanAmount) {
      return res.status(400).json({
        success: false,
        message: `Maximum loan you can access is ₦${maxLoanAmount.toLocaleString()}.`,
      });
    }

    // =========================
    // Calculate Interest & Repayable
    // =========================

    const memberTier = (user.tier || "bronze").toLowerCase();
    const interestRate = settings.interestRates[memberTier] || 10;
    const interestAmount = Math.round(Number(amount) * (interestRate / 100));
    const totalRepayable = Number(amount) + interestAmount;

    const activeStatuses = ["waiting_guarantor", "pending_review", "active", "warning_30_days", "defaulted_60_days", "restricted_90_days", "recovery_120_days"];
    const guarantors = [];
    for (const referralCode of referralCodes) {
      const guarantor = await User.findOne({ referralCode });
      if (!guarantor) return res.status(404).json({ success: false, message: `Guarantor ${referralCode} was not found.` });
      if (guarantor._id.toString() === userId.toString()) return res.status(400).json({ success: false, message: "You cannot select yourself as a guarantor." });

      const activeGuarantee = await Loan.findOne({ "guarantors.userId": guarantor._id, status: { $in: activeStatuses } });
      if (activeGuarantee) return res.status(400).json({ success: false, message: `${guarantor.fullName} is already serving as a guarantor.` });
      if (await getNetSavings(guarantor._id) < settings.eligibility.minSavings) {
        return res.status(400).json({ success: false, message: `${guarantor.fullName} is not eligible to act as a guarantor.` });
      }

      guarantors.push({
        user: guarantor,
        verificationToken: crypto.randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });
    }

    // =========================
    // Create Loan Document
    // =========================

    const newLoan = await Loan.create({
      userId,
      loanNumber: await Loan.generateLoanNumber(),
      principalAmount: Number(amount),
      interestRate,
      interestAmount,
      totalRepayable,
      durationMonths,
      amountPaid: 0,
      remainingBalance: totalRepayable,
      tier: tierName,
      status: "waiting_guarantor",
      installments: [],
      loanType: loanType || "cooperative",
      disbursementMethod: disbursementMethod || "bank_transfer",
      purpose: purpose || "",
      guarantors: guarantors.map(({ user: guarantor, verificationToken }) => ({
        userId: guarantor._id,
        fullName: guarantor.fullName,
        email: guarantor.email,
        phone: guarantor.phone,
        referralCode: guarantor.referralCode,
        status: "pending",
        verificationToken,
        guaranteedAmount: totalRepayable,
        remainingGuaranteedBalance: totalRepayable,
      })),
    });

    // =========================
    // Create Guarantor Record
    // =========================

    await Guarantor.insertMany(guarantors.map(({ user: guarantor, verificationToken, expiresAt }, index) => ({
      loanId: newLoan._id,
      applicantId: userId,
      guarantorUserId: guarantor._id,
      guarantorName: guarantor.fullName,
      guarantorEmail: guarantor.email,
      guarantorPhone: guarantor.phone || "Not provided",
      relationship: "cooperative member",
      guaranteedAmount: totalRepayable,
      remainingGuaranteedBalance: totalRepayable,
      verificationToken,
      tokenExpiresAt: expiresAt,
      status: "pending",
    })));

    // =========================
    // Create Notifications
    // =========================

    await Promise.all([
      createNotification({
        userId,
        type: "loan",
        title: "Loan Application Submitted",
        message:
          "Your loan application has been submitted and is awaiting guarantor confirmation.",
      }),

      ...guarantors.map(({ user: guarantor, verificationToken }) => createNotification({
        userId: guarantor._id,
        type: "loan",
        title: "Loan Guarantee Request",
        message: `${user.fullName} selected you as a guarantor for a loan of ₦${Number(amount).toLocaleString()}. Tap to review and respond.`,
        data: { token: verificationToken, loanId: newLoan._id },
      })),
    ]);

    return res.status(201).json({
      success: true,
      message: "Loan application submitted. Awaiting all three guarantor approvals.",
      loan: newLoan,
    });
  } catch (err) {
    next(err);
  }
};
// PUT /api/loans/approve/:loanId
exports.approveAndDisburseLoan = async (req, res, next) => {
  try {
    if (
      !["super_admin", "finance_manager"].includes(req.user.role)
    ) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized. Only authorized finance staff can approve loans.",
      });
    }
    const { loanId } = req.params;

    const loan = await Loan.findById(loanId);

    if (!loan) {
      return res.status(404).json({
        success: false,
        message: "Loan not found.",
      });
    }

    // Ensure the loan is awaiting admin review
    if (loan.status !== "pending_review") {
      return res.status(400).json({
        success: false,
        message: "Loan is not awaiting admin approval.",
      });
    }

    // Guarantor validations
    if (!loan.guarantor && (!loan.guarantors || loan.guarantors.length !== 3)) {
      return res.status(400).json({
        success: false,
        message: "No guarantor is attached to this loan.",
      });
    }

    if (loan.guarantors?.length === 3 && !loan.guarantors.every((guarantor) => guarantor.status === "accepted")) {
      return res.status(400).json({
        success: false,
        message: "All guarantors must accept this loan before approval.",
      });
    }


    const disbursedAt = new Date();

    // ===========================
    // Generate Installments
    // ===========================

    const installmentAmount = Math.floor(
      loan.totalRepayable / loan.durationMonths
    );

    const installments = [];
    let allocated = 0;

    for (let i = 1; i <= loan.durationMonths; i++) {
      let amountDue = installmentAmount;

      // Last installment gets the remainder
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
        status: "unpaid", // Updated from 'pending' to match schema
        penaltyApplied: false,
      });
    }

    // ===========================
    // Activate Loan & Guarantor
    // ===========================

    loan.status = "active";
    loan.disbursedAt = disbursedAt;
    loan.approvedAt = new Date();
    loan.reviewedAt = new Date();
    loan.approvedBy = req.user._id;

    loan.payoutStatus = "completed";
    loan.payoutReference = `PAYOUT-${Date.now()}`;

    loan.installments = installments;

    // Reset repayment values and sync guarantor balance
    loan.amountPaid = 0;
    loan.remainingBalance = loan.totalRepayable;

// ===========================
// SYNC ACTIVE GUARANTORS
// ===========================

// Guarantors were already activated individually
// when they accepted their guarantee requests.
//
// Admin approval does NOT activate them.
// Admin approval activates the LOAN.

if (loan.guarantors?.length === 3) {
  loan.guarantors.forEach((guarantor) => {
    guarantor.status = "active";

    guarantor.remainingGuaranteedBalance =
      loan.remainingBalance || loan.totalRepayable;
  });
} else if (loan.guarantor) {
  loan.guarantor.status = "active";

  loan.guarantor.remainingGuaranteedBalance =
    loan.remainingBalance || loan.totalRepayable;
}

    // Track timeline audit history if array exists on schema
    if (Array.isArray(loan.timeline)) {
      loan.timeline.push(
        {
          action: "loan_approved",
          note: "Loan approved and disbursed by admin.",
          by: req.user._id,
        },
        {
          action: "guarantee_activated",
          note: "Guarantor liability officially activated.",
          by: req.user._id,
        }
      );
    }

    await loan.save();

    // ===========================
    // Notifications
    // ===========================

    // Collect every guarantor's userId regardless of which shape this loan
    // uses: the legacy single `guarantor` object, or the `guarantors[]`
    // array (the one applyForLoan actually populates — 3 guarantors).
    // Previously this only ever read `loan.guarantor.userId`, which is the
    // wrong field name (`guarantorUserId`) AND the wrong object for the
    // array case, so guarantors were never actually notified.
    const guarantorUserIds = [];

    if (loan.guarantor?.guarantorUserId) {
      guarantorUserIds.push(loan.guarantor.guarantorUserId);
    }

    if (Array.isArray(loan.guarantors)) {
      loan.guarantors.forEach((g) => {
        if (g?.userId) guarantorUserIds.push(g.userId);
      });
    }

    await Promise.all([
      createNotification({
        userId: loan.userId,
        type: "loan",
        title: "Loan Approved",
        message: `Congratulations! Your loan of ₦${loan.principalAmount.toLocaleString()} has been approved.`,
      }),
      ...guarantorUserIds.map((guarantorUserId) =>
        createNotification({
          userId: guarantorUserId,
          type: "guarantor",
          title: "Guarantee Activated",
          message: `The loan you guaranteed for ${loan.loanNumber} has been approved and is now active.`,
        })
      ),
    ]);

    return res.status(200).json({
      success: true,
      message: "Loan approved and disbursed successfully.",
      loan,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/loans/repay/initai
// POST /api/loans/repay/initai
const processLoanRepayment = async ({
  loanId,
  transactionId,
  paymentAmount,
  paymentReference,
  paymentMethod = "paystack",
  verifiedData,
}) => {
  const session = await Loan.startSession();
  session.startTransaction();

  try {
    const loan = await Loan.findById(loanId).session(session);

    if (!loan) {
      throw new Error("Loan not found.");
    }

    const payment = Number(paymentAmount);

    if (isNaN(payment) || payment <= 0) {
      throw new Error("Invalid payment amount.");
    }

    // Include recovery/overdue statuses if your system allows payments when delinquent
    const allowedStatuses = [
      "active",
      "warning_30_days",
      "defaulted_60_days",
      "restricted_90_days",
      "recovery_120_days",
    ];

    if (!allowedStatuses.includes(loan.status)) {
      throw new Error("Loan is not active or eligible for repayment.");
    }

    // Prevent duplicate repayment processing on the loan
    const alreadyProcessed = (loan.repaymentHistory || []).some(
      (r) => String(r.transactionId) === String(transactionId) || (r.reference && r.reference === paymentReference)
    );

    if (alreadyProcessed) {
      await session.abortTransaction();
      session.endSession();
      return loan;
    }

    // ==========================
    // Apply late penalties
    // ==========================

    const settings = await getSystemSettings();
    const latePenaltyRate = settings.latePenaltyRate || 2;

    let totalPenalty = 0;
    const now = new Date();

    for (const installment of loan.installments) {
      if (
        installment.status !== "paid" &&
        !installment.penaltyApplied &&
        installment.dueDate &&
        new Date(installment.dueDate) < now
      ) {
        installment.status = "overdue";

        const overdueAmount =
          installment.amountDue - installment.amountPaid;

        const penalty = Math.round(
          overdueAmount * (latePenaltyRate / 100)
        );

        totalPenalty += penalty;
        installment.penaltyApplied = true;
      }
    }

    if (totalPenalty > 0) {
      loan.totalRepayable = Math.round(
        loan.totalRepayable + totalPenalty
      );
      loan.remainingBalance = Math.round(
        loan.remainingBalance + totalPenalty
      );
    }

    // ==========================
    // Apply repayment
    // ==========================

    loan.amountPaid += payment;

    loan.remainingBalance = Math.max(
      0,
      loan.totalRepayable - loan.amountPaid
    );

    let remainingPayment = payment;

    for (const installment of loan.installments) {
      if (
        installment.status !== "paid" &&
        remainingPayment > 0
      ) {
        const amountNeeded =
          installment.amountDue - installment.amountPaid;

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

    // ==========================
    // Sync Guarantor Liability & Status
    // ==========================

    if (loan.guarantor) {
      loan.guarantor.remainingGuaranteedBalance = loan.remainingBalance;
    }

    if (loan.remainingBalance <= 0) {
      loan.status = "completed";
      loan.completedAt = new Date();

      if (loan.guarantor) {
        loan.guarantor.status = "released";
        loan.guarantor.guaranteeReleasedAt = new Date();
        loan.guarantor.remainingGuaranteedBalance = 0;
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

await loan.save({ session });

    // ==========================
    // Save repayment transaction
    // ==========================

const repaymentTransaction = await Savings.findOne({
  reference: paymentReference,
  type: "loan_repayment",
}).session(session);

if (repaymentTransaction) {
  repaymentTransaction.status = "completed";
  repaymentTransaction.amount = payment;
  repaymentTransaction.transactionId = transactionId;
  repaymentTransaction.loanId = loan._id;

  await repaymentTransaction.save({ session });
} else {
  await Savings.create(
    [
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
    ],
    { session }
  );
}

    await session.commitTransaction();
    session.endSession();

    // ==========================
    // Post-Transaction Operations
    // ==========================

    await updateUserScore(loan.userId, "loan_repayment");

    await logAudit({
      userId: loan.userId,
      action: "loan_repayment",
      targetType: "loan",
      targetId: loan._id,
      details: {
        paymentAmount,
        transactionId,
        reference: paymentReference,
        remainingBalance: loan.remainingBalance,
        penaltyApplied: totalPenalty,
        completed: loan.status === "completed",
      },
    });

    // ==========================
    // Notifications
    // ==========================

    let message = `Loan repayment of ₦${Number(
      paymentAmount
    ).toLocaleString()} received successfully.`;

    if (totalPenalty > 0) {
      message += ` ₦${totalPenalty.toLocaleString()} late penalty applied.`;
    }

    if (loan.status === "completed") {
      message += " Congratulations! Your loan has been fully repaid.";
    }

    const notifications = [
      createNotification({
        userId: loan.userId,
        type: "loan",
        title: "Loan Repayment Successful",
        message,
      }),
    ];

    // Notify every guarantor when the loan is fully settled (handles both
    // the legacy single-guarantor field and the guarantors[] array that
    // applyForLoan actually populates).
    if (loan.status === "completed") {
      const releasedGuarantorIds = [];

      if (loan.guarantor?.guarantorUserId) {
        releasedGuarantorIds.push(loan.guarantor.guarantorUserId);
      }

      if (Array.isArray(loan.guarantors)) {
        loan.guarantors.forEach((g) => {
          if (g?.userId) releasedGuarantorIds.push(g.userId);
        });
      }

      releasedGuarantorIds.forEach((guarantorUserId) => {
        notifications.push(
          createNotification({
            userId: guarantorUserId,
            type: "guarantor",
            title: "Guarantee Released",
            message: `The loan you guaranteed for ${loan.loanNumber} has been fully repaid. Your guarantee liability has been released.`,
          })
        );
      });
    }

    await Promise.all(notifications);

    return loan;
  } catch (err) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    throw err;
  }
};


module.exports.processLoanRepayment = processLoanRepayment;


exports.initializeLoanRepayment = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { loanId, paymentAmount } = req.body;

    if (!loanId || !paymentAmount) {
      return res.status(400).json({
        success: false,
        message: "Loan ID and payment amount are required.",
      });
    }

    const loan = await Loan.findOne({
      _id: loanId,
      userId,
      status: {
        $in: [
          "active",
          "warning_30_days",
          "defaulted_60_days",
          "restricted_90_days",
        ],
      },
    });

    if (!loan) {
      return res.status(404).json({
        success: false,
        message: "No payable loan found.",
      });
    }

    const amount = Math.round(Number(paymentAmount));

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid repayment amount.",
      });
    }

    // if (amount > loan.remainingBalance) {
    //   return res.status(400).json({
    //     success: false,
    //     message: `Repayment cannot exceed your outstanding balance of ₦${loan.remainingBalance.toLocaleString()}.`,
    //   });
    // }

    const tx_ref = `LRP_${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    // Persist a pending record so the webhook can reconcile this payment
    // even if the client never returns to call /repay/verify (browser
    // closed, network dropped, app killed, etc.) — without this, a
    // successful Paystack charge with no matching client call was
    // previously unrecoverable.
    await Savings.create({
      userId,
      loanId: loan._id,
      amount,
      type: "loan_repayment",
      method: "paystack",
      status: "pending",
      reference: tx_ref,
    });

    console.log(PAYSTACK_PUBLIC_KEY, tx_ref, amount);
    return res.status(200).json({
      success: true,
      data: {
        publicKey: process.env.PAYSTACK_PUBLIC_KEY,
        reference: tx_ref,
        tx_ref, // kept for any frontend code still reading tx_ref
        amount,
        amountKobo: Math.round(amount * 100),
        currency: "NGN",

        customer: {
          email: req.user.email,
          name: req.user.fullName,
          phone_number: req.user.phone || "",
        },

        customizations: {
          title: "Socket Moni Loan Repayment",
          description: `Repayment for Loan ${loan.loanNumber || loan._id}`,
          logo: process.env.APP_LOGO || "",
        },

        metadata: {
          paymentType: "loan_repayment",
          loanId: loan._id.toString(),
          userId: userId.toString(),
        },

        redirect_url: `${process.env.CLIENT_URL}/loan/payment/callback`,
      },
    });
  } catch (err) {
    next(err);
  }
};


const { verifyPayment } = require("../Utilis/Paystack");

exports.verifyLoanRepayment = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { loanId, reference, tx_ref, transactionId } = req.body;

    // Paystack verifies by `reference` -- a single string, unlike
    // 's separate numeric transactionId + tx_ref pair. Accept
    // any of the field names the frontend might still be sending during
    // rollout, but they must all point at the same reference.
    const paymentRef = reference || tx_ref || transactionId;

    console.log("VERIFY BODY:", req.body);

    if (!loanId || !paymentRef) {
      return res.status(400).json({
        success: false,
        message: "loanId and reference are required.",
      });
    }

    // Verify payment with Paystack
    const verification = await verifyPayment(paymentRef);

    console.log("Paystack Verification:", verification);

    if (!verification || verification.status !== "success") {
      return res.status(400).json({
        success: false,
        message: "Unable to verify payment.",
      });
    }

    const payment = verification.data;

    console.log("Verified Payment:", payment);

    const paymentStatus = (payment.status || "").trim().toLowerCase();

    // Accept all successful payment statuses
    if (!["completed", "success", "successful"].includes(paymentStatus)) {
      return res.status(400).json({
        success: false,
        message: `Payment not successful. Status: ${payment.status}`,
      });
    }

    const paymentReference = (
      payment.tx_ref ||
      payment.reference ||
      ""
    ).trim();


    // Validate repayment reference
    if (
      !paymentReference ||
      !["LRP_", "RPL_"].some((prefix) =>
        paymentReference.startsWith(prefix)
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid loan repayment reference.",
      });
    }

    if (paymentReference !== paymentRef) {
      return res.status(400).json({
        success: false,
        message: "Payment reference mismatch.",
      });
    }

    // Find loan
    const loan = await Loan.findOne({
      _id: loanId,
      userId,
      status: {
        $in: ["active", "warning_30_days"],
      },
    });

    if (!loan) {
      return res.status(404).json({
        success: false,
        message: "Loan not found.",
      });
    }

    const paymentAmount = Number(
      payment.amount_settled ?? payment.amount
    );

    if (!paymentAmount || paymentAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount.",
      });
    }

    // Mark the pending Savings record (created in initializeLoanRepayment)
    // completed here too, so the direct-verify path and the webhook
    // fallback path leave the record in the same state either way.
    await Savings.updateOne(
      { reference: paymentReference, type: "loan_repayment", status: "pending" },
      { $set: { status: "completed", transactionId: String(payment.id), amount: paymentAmount } }
    );

    const updatedLoan = await processLoanRepayment({
      loanId: loan._id,
      transactionId: String(payment.id || paymentRef),
      paymentAmount,
      paymentReference,
      paymentMethod: "paystack",
      verifiedData: payment,
    });

    return res.status(200).json({
      success: true,
      message: "Loan repayment verified successfully.",
      loan: updatedLoan,
    });
  } catch (err) {
    console.error("Loan Verification Error:", err);
    next(err);
  }
};

const { runLoanDefaulterEscalation } = require("../Utilis/loanDefaulterEngine");

// POST /api/loans/admin/process-defaulters
exports.triggerLoanDefaulterCheck = async (req, res, next) => {
  try {
    // AFTER
    if (!["super_admin", "finance_manager"].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Unauthorized." });
    }

    const result = await runLoanDefaulterEscalation();

    return res.status(200).json({
      success: true,
      message: "Loan defaulter escalation process executed successfully.",
      data: result.summary,
    });
  } catch (err) {
    next(err);
  }
};