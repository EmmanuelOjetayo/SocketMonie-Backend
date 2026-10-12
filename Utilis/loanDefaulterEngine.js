const Loan = require("../Models/LoanModel");
const User = require("../Models/UserModel");
const RecoveryObligation = require("../Models/RecoveryObligationModel");
const { createNotification } = require("./notificationHelper");

const getOldestOverdueDays = (installments) => {
  const now = new Date();
  let maxDaysOverdue = 0;

  for (const inst of installments) {
    if (inst.status !== "paid" && inst.dueDate && new Date(inst.dueDate) < now) {
      const diffMs = now.getTime() - new Date(inst.dueDate).getTime();
      const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (days > maxDaysOverdue) {
        maxDaysOverdue = days;
      }
    }
  }

  return maxDaysOverdue;
};

/**
 * Initialize or update recovery obligations for defaulted loans.
 * Ensures borrower savings are NOT deducted, and distributes the remaining balance
 * evenly among active guarantors.
 */
const syncRecoveryObligations = async (loan) => {
  if (!loan || loan.remainingBalance <= 0) return [];

  const activeGuarantors = loan.guarantors?.filter((g) => !g.isReplaced && (g.status === "accepted" || g.status === "active")) || [];
  if (activeGuarantors.length === 0) return [];

  const sharePerGuarantor = Math.ceil(loan.remainingBalance / activeGuarantors.length);
  const monthlyShare = Math.ceil(sharePerGuarantor / Math.max(1, loan.durationMonths || 3));
  const obligations = [];

  for (const g of activeGuarantors) {
    let obligation = await RecoveryObligation.findOne({
      loanId: loan._id,
      guarantorUserId: g.userId,
    });

    if (!obligation) {
      obligation = await RecoveryObligation.create({
        loanId: loan._id,
        borrowerId: loan.userId,
        guarantorUserId: g.userId,
        guarantorName: g.fullName,
        originalGuaranteedAmount: g.guaranteedAmount || loan.totalRepayable,
        totalAssignedRecovery: sharePerGuarantor,
        amountRecovered: 0,
        remainingRecoveryBalance: sharePerGuarantor,
        monthlyRecoveryAmount: monthlyShare,
        status: "active",
      });
    } else if (obligation.status === "active") {
      // Reconcile remaining recovery balance if loan balance changed
      const remainingTarget = Math.min(obligation.remainingRecoveryBalance, loan.remainingBalance);
      obligation.remainingRecoveryBalance = remainingTarget;
      await obligation.save();
    }
    obligations.push(obligation);
  }

  return obligations;
};

/**
 * Recovery is now explicit: this function only ensures obligations exist.
 * It must not deduct guarantor or borrower savings automatically.
 */
const processGuarantorRecoveryMonthly = async (loan) => {
  if (loan.remainingBalance <= 0) return;
  await syncRecoveryObligations(loan);
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
  let restrictedCount = 0;
  let guarantorNotifiedCount = 0;
  let recoveryCount = 0;

  for (const loan of activeLoans) {
    const daysOverdue = getOldestOverdueDays(loan.installments);
    if (daysOverdue === 0) continue;

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
        title: "⚠️ Urgent: Loan Repayment Overdue (30 Days)",
        message: `Your loan repayment is 30 days overdue. Please clear your balance of ₦${loan.remainingBalance.toLocaleString()} to avoid account restriction.`,
      });
    }

    // Stage 2: 60 Days Late
    else if (daysOverdue >= 60 && daysOverdue < 90 && loan.status !== "defaulted_60_days") {
      loan.status = "defaulted_60_days";
      await loan.save();
      await User.findByIdAndUpdate(user._id, { status: "restricted" });
      restrictedCount++;

      await createNotification({
        userId: user._id,
        type: "loan",
        title: "🚫 Account Restricted: Loan Overdue (60 Days)",
        message: `Your loan repayment is 60 days overdue. Account features restricted. Immediate payment required.`,
      });
    }

    // Stage 3: 90 Days Late
    else if (daysOverdue >= 90 && daysOverdue < 120 && loan.status !== "restricted_90_days") {
      loan.status = "restricted_90_days";
      await loan.save();
      guarantorNotifiedCount++;

      // Initialize recovery obligations
      await syncRecoveryObligations(loan);

      await createNotification({
        userId: user._id,
        type: "loan",
        title: "🚨 Guarantor Contacted: Loan Overdue (90 Days)",
        message: `Your loan repayment is 90 days overdue. Your guarantors have been formally notified regarding this debt.`,
      });
    }

    // Stage 4: 120 Days Late (Recovery Active)
    else if (daysOverdue >= 120) {
      if (loan.status !== "recovery_120_days") {
        loan.status = "recovery_120_days";
        loan.recoveryStatus = "in_recovery";
        await loan.save();
        recoveryCount++;
      }
      // Execute guarantor monthly recovery deduction
      await processGuarantorRecoveryMonthly(loan);
    }
  }

  return {
    success: true,
    summary: {
      warningCount,
      restrictedCount,
      guarantorNotifiedCount,
      recoveryCount,
    },
  };
};

module.exports = {
  runLoanDefaulterEscalation,
  processGuarantorRecoveryMonthly,
  syncRecoveryObligations,
};