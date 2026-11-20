const Loan = require("../Models/LoanModel");
const User = require("../Models/UserModel");
const RecoveryObligation = require("../Models/RecoveryObligationModel");
const { ScoreRepository } = require("../Repositories/ScoreRepository");
const { createNotification } = require("./notificationHelper");

// Confirmed SocketScore rule: a failed guarantor collection attempt is -10.
const GUARANTOR_FAILURE_SCORE_DELTA = -10;

const applyFailedGuarantorCollectionScore = async (guarantorUserId, reference) => {
  if (!guarantorUserId) return null;
  const user = await User.findById(guarantorUserId);
  if (!user) return null;
  const previous = Number(user.socketScore || 0);
  const next = Math.max(0, Math.min(100, previous + GUARANTOR_FAILURE_SCORE_DELTA));
  await ScoreRepository.updateUserScore(guarantorUserId, next, user.socketScoreBreakdown || {});
  await ScoreRepository.pushUserScoreHistory(guarantorUserId, {
    total: next,
    breakdown: {
      event: "failed_guarantor_collection",
      delta: GUARANTOR_FAILURE_SCORE_DELTA,
      previous,
      reference,
    },
    recordedAt: new Date(),
  });
  return next;
};

const getOldestOverdueDays = (installments = []) => {
  const now = new Date();
  let maxDaysOverdue = 0;
  for (const inst of installments) {
    if (inst.status !== "paid" && inst.dueDate && new Date(inst.dueDate) < now) {
      const diffMs = now.getTime() - new Date(inst.dueDate).getTime();
      const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (days > maxDaysOverdue) maxDaysOverdue = days;
    }
  }
  return maxDaysOverdue;
};

/**
 * Recovery obligation (defaulted_60_days trigger):
 * - Overdue installment amount(s) outstanding
 * - Plus installment amount due for the current month (outstanding), if any
 * Split equally across 4 active guarantors (25% each), capped by guaranteed amount
 * and loan remaining balance context. No actual deductions executed here.
 */
const calculateRecoveryObligationAmount = (loan, now = new Date()) => {
  const installments = Array.isArray(loan?.installments) ? loan.installments : [];
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  let overdueOutstanding = 0;
  let currentMonthOutstanding = 0;

  for (const inst of installments) {
    const amountDue = Number(inst.amountDue || 0);
    const amountPaid = Number(inst.amountPaid || 0);
    const outstanding = Math.max(0, amountDue - amountPaid);
    if (outstanding <= 0 || inst.status === "paid") continue;

    const dueDate = inst.dueDate ? new Date(inst.dueDate) : null;
    const isOverdue = dueDate ? dueDate < now : (inst.status === "overdue");

    if (isOverdue) {
      overdueOutstanding += outstanding;
    } else if (dueDate && dueDate.getMonth() === currentMonth && dueDate.getFullYear() === currentYear) {
      // Current month installment due (not overdue yet) included per recovery rule.
      currentMonthOutstanding += outstanding;
    }
  }

  const total = Math.max(0, Math.round((overdueOutstanding + currentMonthOutstanding) * 100) / 100);
  return {
    totalRecoveryObligation: Math.min(total, Math.max(0, Number(loan.remainingBalance || 0))),
    overdueOutstanding: Math.round(overdueOutstanding * 100) / 100,
    currentMonthOutstanding: Math.round(currentMonthOutstanding * 100) / 100,
  };
};

const syncRecoveryObligations = async (loan) => {
  if (!loan) return [];

  const activeGuarantors = (loan.guarantors || []).filter(
    (g) => !g.isReplaced && (g.status === "accepted" || g.status === "active")
  );
  if (activeGuarantors.length === 0) return [];

  const { totalRecoveryObligation, overdueOutstanding, currentMonthOutstanding } = calculateRecoveryObligationAmount(loan);
  const obligations = [];

  // If borrower has resumed repayment / no relevant obligation remains, reduce/close active obligations.
  if (totalRecoveryObligation <= 0 || Number(loan.remainingBalance || 0) <= 0) {
    for (const g of activeGuarantors) {
      const obligation = await RecoveryObligation.findOne({ loanId: loan._id, guarantorUserId: g.userId });
      if (!obligation) continue;
      obligation.remainingRecoveryBalance = 0;
      obligation.monthlyRecoveryAmount = 0;
      obligation.currentCycleObligation = 0;
      obligation.currentCycleOverdueAmount = 0;
      obligation.currentCycleCurrentMonthAmount = 0;
      obligation.deductionExecutionStatus = "not_enabled";
      obligation.lastCalculatedAt = new Date();
      if ((obligation.amountRecovered || 0) >= (obligation.totalAssignedRecovery || 0) && (obligation.totalAssignedRecovery || 0) > 0) {
        obligation.status = "completed";
        obligation.completedAt = obligation.completedAt || new Date();
      } else if ((obligation.amountRecovered || 0) > 0) {
        obligation.status = "partially_paid";
      } else {
        obligation.status = "cancelled";
      }
      await obligation.save();
      obligations.push(obligation);
    }
    return obligations;
  }

  const shareCount = 4; // four guarantors collectively guarantee 100% (25% each)
  // Fixed 25% share per active guarantor. The last guarantor never absorbs
  // another guarantor's unpaid share.
  const share = Math.floor((totalRecoveryObligation / shareCount) * 100) / 100;
  // Hard cap: 25% of the ORIGINAL approved principal, regardless of legacy
  // guaranteedAmount values or the outstanding balance.
  const principalCap =
    Math.round(Number(loan.principalAmount || loan.totalRepayable || 0) * 0.25 * 100) / 100;

  for (let i = 0; i < activeGuarantors.length; i++) {
    const g = activeGuarantors[i];
    const recordedCap = Number(g.guaranteedAmount || 0);
    const guaranteedCap = Math.min(principalCap, recordedCap || principalCap);
    let obligation = await RecoveryObligation.findOne({ loanId: loan._id, guarantorUserId: g.userId });

    if (!obligation) {
      const cappedShare = Math.max(0, Math.min(share, guaranteedCap));
      obligation = await RecoveryObligation.create({
        loanId: loan._id,
        borrowerId: loan.userId,
        guarantorUserId: g.userId,
        guarantorName: g.fullName,
        originalGuaranteedAmount: guaranteedCap,
        totalAssignedRecovery: cappedShare,
        amountRecovered: 0,
        remainingRecoveryBalance: cappedShare,
        monthlyRecoveryAmount: cappedShare, // current recovery-cycle share (tracking only; no auto deduction)
        currentCycleObligation: totalRecoveryObligation,
        currentCycleShare: cappedShare,
        currentCycleOverdueAmount: overdueOutstanding,
        currentCycleCurrentMonthAmount: currentMonthOutstanding,
        status: "active",
        lastCalculatedAt: new Date(),
        deductionExecutionStatus: "not_enabled", // infrastructure only; no authorized deduction mechanism activated
      });
    } else {
      const recovered = Number(obligation.amountRecovered || 0);
      const maxRemainingByGuarantee = Math.max(0, guaranteedCap - recovered);
      const targetShare = Math.max(0, Math.min(share, maxRemainingByGuarantee));
      // Never increase recovered amounts here; only recalculate outstanding obligation for tracking.
      obligation.originalGuaranteedAmount = guaranteedCap || obligation.originalGuaranteedAmount;
      obligation.totalAssignedRecovery = Math.max(Number(obligation.totalAssignedRecovery || 0), targetShare);
      obligation.remainingRecoveryBalance = targetShare;
      obligation.monthlyRecoveryAmount = targetShare;
      obligation.currentCycleObligation = totalRecoveryObligation;
      obligation.currentCycleShare = targetShare;
      obligation.currentCycleOverdueAmount = overdueOutstanding;
      obligation.currentCycleCurrentMonthAmount = currentMonthOutstanding;
      obligation.lastCalculatedAt = new Date();
      if (!obligation.deductionExecutionStatus) obligation.deductionExecutionStatus = "not_enabled";
      if (targetShare <= 0 && recovered > 0) {
        obligation.status = "partially_paid";
      } else if (targetShare <= 0 && recovered <= 0) {
        obligation.status = "cancelled";
      } else {
        obligation.status = "active";
      }
      await obligation.save();
    }
    obligations.push(obligation);
  }

  return obligations;
};

// Explicit recovery processing infrastructure only (no automatic deductions).
const processGuarantorRecoveryMonthly = async (loan) => {
  if (!loan || loan.remainingBalance <= 0) return;
  await syncRecoveryObligations(loan);
};

/**
 * Initiate guarantor recovery collection attempt.
 * This is the authorized entry point for guarantor deductions.
 * Must be called after loan enters defaulted_60_days state.
 * Triggers collection tracking; actual deduction execution requires
 * provider integration and guarantor mandate consent.
 */
const initiateGuarantorRecovery = async (loanId, collectionContext = {}) => {
  const loan = await Loan.findById(loanId);
  if (!loan) throw new AppError("Loan not found.", 404);

  if (loan.status !== "defaulted_60_days") {
    throw new AppError("Guarantor recovery can only be initiated when loan is in defaulted_60_days state.", 400);
  }

  await syncRecoveryObligations(loan);

  // Collect obligations and attempt tracking
  const obligations = await syncRecoveryObligations(loan);
  return {
    success: true,
    obligations,
    message: "Guarantor recovery tracking initiated. Collection attempts require guarantor mandate consent and provider integration.",
  };
};

/**
 * Record a guarantor collection attempt.
 * This tracks the attempt without executing a real deduction unless
 * a supported provider integration and mandate consent are available.
 */
const recordGuarantorCollectionAttempt = async (obligationId, amount, mandates = {}) => {
  const obligation = await RecoveryObligation.findById(obligationId);
  if (!obligation) throw new AppError("Recovery obligation not found.", 404);

  const attemptFailed = String(mandates.status || "").toLowerCase() === "failed";
  const scorePenaltyApplied = attemptFailed;

  // Check deduction execution status
  if (obligation.deductionExecutionStatus === "not_enabled") {
    // Infrastructure not yet enabled for actual deductions. This is a tracking
    // record, NOT a failed collection, unless the caller explicitly reports one.
    const deduction = {
      amount,
      status: attemptFailed ? "failed" : "pending",
      attemptedAt: new Date(),
      reference: `INFRA_${obligation._id}_${Date.now()}`,
      failureReason: attemptFailed
        ? mandates.failureReason || "Guarantor collection failed"
        : "Collection mechanism not yet activated - mandate/consent provider integration required",
      scorePenaltyApplied,
    };
    obligation.deductions.push(deduction);
    const savedDeduction = obligation.deductions[obligation.deductions.length - 1];
    obligation.lastDeductionAt = new Date();
    await obligation.save();
    if (attemptFailed) {
      try {
        savedDeduction.scoreResult = await applyFailedGuarantorCollectionScore(
          obligation.guarantorUserId,
          savedDeduction.reference
        );
        await obligation.save();
      } catch (scoreErr) {
        console.error(
          `[SCORE] failed guarantor collection penalty failed for ${obligation.guarantorUserId}:`,
          scoreErr?.message || scoreErr
        );
      }
    }
    return {
      status: attemptFailed ? "failed" : "tracked_infrastructure_only",
      message: attemptFailed
        ? "Failed collection attempt recorded; guarantor SocketScore reduced by 10."
        : "Collection attempt tracked at infrastructure level. Mandate/consent provider integration required for actual execution.",
    };
  }

  // If execution is enabled, attempt the collection (placeholder for provider integration)
  // This would integrate with a supported collection provider.
  const deduction = {
    amount,
    status: "pending",
    attemptedAt: new Date(),
    reference: `COLL_${obligation._id}_${Date.now()}`,
    ...mandates,
    scorePenaltyApplied,
  };
  obligation.deductions.push(deduction);
  const savedDeduction = obligation.deductions[obligation.deductions.length - 1];
  obligation.lastDeductionAt = new Date();
  await obligation.save();

  if (attemptFailed) {
    try {
      savedDeduction.scoreResult = await applyFailedGuarantorCollectionScore(
        obligation.guarantorUserId,
        savedDeduction.reference
      );
      await obligation.save();
    } catch (scoreErr) {
      console.error(
        `[SCORE] failed guarantor collection penalty failed for ${obligation.guarantorUserId}:`,
        scoreErr?.message || scoreErr
      );
    }
  }

  return {
    status: attemptFailed ? "failed" : "attempt_recorded",
    message: attemptFailed
      ? "Failed collection attempt recorded; guarantor SocketScore reduced by 10."
      : "Collection attempt recorded. Actual execution depends on provider integration and mandate consent.",
  };
};

/**
 * Complete a guarantor collection (successful deduction).
 * This updates the obligation records to reflect actual recovered amount.
 */
const completeGuarantorCollection = async (obligationId, amount, providerRef = "") => {
  const obligation = await RecoveryObligation.findById(obligationId);
  if (!obligation) throw new AppError("Recovery obligation not found.", 404);

  // Update obligation records
  obligation.amountRecovered = Math.min(obligation.amountRecovered + amount, obligation.totalAssignedRecovery || 0);
  obligation.remainingRecoveryBalance = Math.max(0, (obligation.totalAssignedRecovery || 0) - (obligation.amountRecovered || 0));
  obligation.lastDeductionAt = new Date();

  // Update deduction records
  const lastDeduction = obligation.deductions[obligation.deductions.length - 1];
  if (lastDeduction) {
    lastDeduction.status = "completed";
    lastDeduction.paidAt = new Date();
    lastDeduction.providerReference = providerRef;
  }

  // Update status based on recovered amount
  if ((obligation.amountRecovered || 0) >= (obligation.totalAssignedRecovery || 0) && (obligation.totalAssignedRecovery || 0) > 0) {
    obligation.status = "completed";
    obligation.completedAt = obligation.completedAt || new Date();
  } else if ((obligation.amountRecovered || 0) > 0) {
    obligation.status = "partially_paid";
  }

  await obligation.save();
  return obligation;
};

/**
 * Process borrower repayment and recalculate guarantor recovery obligations.
 * When borrower pays, the remaining guarantor obligation should be reduced.
 */
const processBorrowerRepaymentAndRecoverObligation = async (loanId, paymentAmount) => {
  const loan = await Loan.findById(loanId);
  if (!loan) throw new AppError("Loan not found.", 404);

  // Sync current obligations
  await syncRecoveryObligations(loan);

  // Calculate remaining obligation after borrower payment
  const obligations = await RecoveryObligation.find({ loanId: loan._id });
  let totalRecoveredFromGuarantors = 0;

  for (const obligation of obligations) {
    // Reduce the remaining balance proportionally based on payment amount
    // and the loan's remaining balance context
    const previousRemaining = obligation.remainingRecoveryBalance;
    // proportional reduction: payment reduces guarantor obligation in same ratio as it reduces loan balance
    // This is a simplified approach - in production, use a more sophisticated allocation
    const ratio = Math.min(1, paymentAmount / Math.max(1, loan.remainingBalance || 1));
    const reduction = Math.max(0, previousRemaining - (previousRemaining * (1 - ratio)));
    obligation.remainingRecoveryBalance = Math.max(0, obligation.remainingRecoveryBalance - reduction);
    obligation.amountRecovered = Math.min(obligation.amountRecovered + reduction, obligation.totalAssignedRecovery || 0);

    // Update status
    if (obligation.amountRecovered >= obligation.totalAssignedRecovery && obligation.totalAssignedRecovery > 0) {
      obligation.status = "completed";
      obligation.completedAt = obligation.completedAt || new Date();
    } else if (obligation.amountRecovered > 0) {
      obligation.status = "partially_paid";
    }

    totalRecoveredFromGuarantors += obligation.amountRecovered;
    await obligation.save();
  }

  // Also reduce the loan's remaining balance to reflect the borrower payment
  loan.amountPaid = Math.min(loan.amountPaid + paymentAmount, loan.totalRepayable);
  loan.remainingBalance = Math.max(0, loan.totalRepayable - loan.amountPaid);

  // If loan is now fully repaid, release guarantors
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
  }

  await loan.save();

  return {
    loan,
    totalRecoveredFromGuarantors,
    message: `Borrower repayment of ₦${paymentAmount} processed. Guarantor recovery obligations recalculated and reduced accordingly.`,
  };
};

const runLoanDefaulterEscalation = async () => {
  const activeLoans = await Loan.find({
    status: {
      $in: [
        "active",
        "warning_30_days",
        "defaulted_60_days",
        "restricted_90_days",
        "recovery_120_days",
      ],
    },
  });

  let warningCount = 0;
  let defaultedCount = 0;
  let guarantorNotifiedCount = 0;
  let recoveryCount = 0;

  for (const loan of activeLoans) {
    const daysOverdue = getOldestOverdueDays(loan.installments || []);

    // Keep recovery tracking accurate when obligations are resolved/reduced.
    if (Number(loan.remainingBalance || 0) <= 0 || daysOverdue === 0) {
      if (["defaulted_60_days", "restricted_90_days", "recovery_120_days", "warning_30_days", "active"].includes(loan.status)) {
        await syncRecoveryObligations(loan);
      }
      continue;
    }

    const user = await User.findById(loan.userId);
    if (!user) continue;

    // Stage 1: 30 Days Late
    if (daysOverdue >= 30 && daysOverdue < 60 && loan.status !== "warning_30_days") {
      loan.status = "warning_30_days";
      await loan.save();
      warningCount++;

      await createNotification({
        userId: user._id,
        type: "loan",
        title: "Loan Repayment Overdue (30 Days)",
        message: "Your loan repayment is 30 days overdue. Please clear your outstanding balance to avoid further escalation.",
      });
    }

    // Stage 2: 60 Days Late (defaulted_60_days) - initiate guarantor recovery infrastructure immediately
    else if (daysOverdue >= 60 && daysOverdue < 90) {
      const enteredNow = loan.status !== "defaulted_60_days";
      if (enteredNow) {
        loan.status = "defaulted_60_days";
        await loan.save();
        await User.findByIdAndUpdate(user._id, { status: "restricted" });
        defaultedCount++;
      }

      // Calculate/track guarantor recovery obligation (no actual deductions executed).
      await syncRecoveryObligations(loan);

      if (enteredNow) {
        await createNotification({
          userId: user._id,
          type: "loan",
          title: "Loan Defaulted (60 Days) - Guarantor Recovery Initiated",
          message: "Your loan is 60 days overdue. Guarantor recovery tracking has been initiated for the overdue installment amount and the current month installment amount (as applicable), split 25% per guarantor subject to guarantee/available-balance limits. No automatic deduction has been executed without an authorized collection mechanism.",
        });
      }
    }

    // Stage 3: 90 Days Late
    else if (daysOverdue >= 90 && daysOverdue < 120) {
      const enteredNow = loan.status !== "restricted_90_days";
      if (enteredNow) {
        loan.status = "restricted_90_days";
        await loan.save();
        guarantorNotifiedCount++;
      }
      await syncRecoveryObligations(loan);

      if (enteredNow) {
        await createNotification({
          userId: user._id,
          type: "loan",
          title: "Loan Restricted (90 Days)",
          message: "Your loan repayment is 90 days overdue. Guarantor recovery obligations remain tracked and are recalculated as repayments are made.",
        });
      }
    }

    // Stage 4: 120 Days Late (Recovery Active state label)
    else if (daysOverdue >= 120) {
      if (loan.status !== "recovery_120_days") {
        loan.status = "recovery_120_days";
        loan.recoveryStatus = "in_recovery";
        await loan.save();
        recoveryCount++;
      }
      // Recovery infrastructure update only; no automatic guarantor deduction execution.
      await processGuarantorRecoveryMonthly(loan);
    } else if (["defaulted_60_days", "restricted_90_days", "recovery_120_days"].includes(loan.status)) {
      await syncRecoveryObligations(loan);
    }
  }

  return {
    success: true,
    summary: {
      warningCount,
      defaultedCount,
      guarantorNotifiedCount,
      recoveryCount,
    },
  };
};

module.exports = {
  runLoanDefaulterEscalation,
  processGuarantorRecoveryMonthly,
  syncRecoveryObligations,
  calculateRecoveryObligationAmount,
  initiateGuarantorRecovery,
  recordGuarantorCollectionAttempt,
  completeGuarantorCollection,
  processBorrowerRepaymentAndRecoverObligation,
};