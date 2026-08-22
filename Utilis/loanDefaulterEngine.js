const Loan = require("../Models/LoanModel");
const User = require("../Models/UserModel");
const Savings = require("../Models/SavingsModel");
const Guarantor = require("../Models/GuarantorModel");
const SystemSettings = require("../Models/SystemSettingsModel");
const { createNotification } = require("./notificationHelper");

/**
 * Helper: Calculate net savings for a user
 */
const getNetSavings = async (userId) => {
  const completedSavings = await Savings.find({ userId, status: "completed" });
  return completedSavings.reduce((sum, item) => {
    if (item.type === "withdrawal") return sum - item.amount;
    if (item.type === "deposit") return sum + item.amount;
    return sum;
  }, 0);
};

/**
 * Helper: Find the oldest overdue days for a loan
 */
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
 * Automatically process monthly guarantor deductions when a borrower fails to pay monthly installment dues
 */
const processGuarantorMonthlyDues = async (loan) => {
  const now = new Date();
  let updated = false;

  for (const inst of loan.installments) {
    if (inst.status !== "paid" && inst.dueDate && new Date(inst.dueDate) < now) {
      const amountNeeded = inst.amountDue - (inst.amountPaid || 0);
      if (amountNeeded <= 0) continue;

      // Step 1: Deduct from borrower's available savings first
      const borrowerSavings = await getNetSavings(loan.userId);
      let borrowerCovered = 0;

      if (borrowerSavings > 0) {
        borrowerCovered = Math.min(borrowerSavings, amountNeeded);
        await Savings.create({
          userId: loan.userId,
          amount: borrowerCovered,
          type: "withdrawal",
          method: "wallet",
          status: "completed",
          reference: `BRW_DUE_${loan._id}_${inst.installmentNumber}_${Date.now()}`,
        });

        inst.amountPaid = (inst.amountPaid || 0) + borrowerCovered;
        loan.remainingBalance = Math.max(0, loan.remainingBalance - borrowerCovered);
        updated = true;
      }

      const remainingInstallment = amountNeeded - borrowerCovered;

      // Step 2: If borrower savings cannot cover full installment, split remaining among guarantors
      if (remainingInstallment > 0) {
        const loanGuarantors = Array.isArray(loan.guarantors) && loan.guarantors.length > 0
          ? loan.guarantors.filter((g) => g.status === "accepted" || g.status === "active")
          : [];

        if (loanGuarantors.length > 0) {
          const sharePerGuarantor = Math.ceil(remainingInstallment / loanGuarantors.length);

          for (const g of loanGuarantors) {
            const gSavings = await getNetSavings(g.userId);
            if (gSavings <= 0) continue;

            const gDeduction = Math.min(gSavings, sharePerGuarantor);

            await Savings.create({
              userId: g.userId,
              amount: gDeduction,
              type: "withdrawal",
              method: "wallet",
              status: "completed",
              reference: `GTR_PAY_${loan._id}_${inst.installmentNumber}_${g.userId}_${Date.now()}`,
            });

            inst.amountPaid = (inst.amountPaid || 0) + gDeduction;
            loan.remainingBalance = Math.max(0, loan.remainingBalance - gDeduction);
            g.remainingGuaranteedBalance = Math.max(0, (g.remainingGuaranteedBalance || loan.totalRepayable) - gDeduction);
            updated = true;

            // Notify Guarantor
            await createNotification({
              userId: g.userId,
              type: "guarantor",
              title: "Automatic Guarantor Loan Deduction",
              message: `₦${gDeduction.toLocaleString()} was deducted from your savings as guarantor for loan ${loan.loanNumber} overdue installment #${inst.installmentNumber}.`,
            });
          }

          // Notify Borrower
          const borrowerUser = await User.findById(loan.userId);
          if (borrowerUser) {
            await createNotification({
              userId: loan.userId,
              type: "loan",
              title: "Guarantors Covered Overdue Installment",
              message: `Your guarantors automatically paid ₦${(amountNeeded - borrowerCovered).toLocaleString()} toward installment #${inst.installmentNumber}. Please repay your loan balance.`,
            });
          }
        }
      }

      if (inst.amountPaid >= inst.amountDue) {
        inst.status = "paid";
        inst.paidAt = new Date();
      } else if (inst.amountPaid > 0) {
        inst.status = "partially_paid";
      }
    }
  }

  if (loan.remainingBalance <= 0) {
    loan.status = "completed";
    loan.completedAt = new Date();
    if (Array.isArray(loan.guarantors)) {
      loan.guarantors.forEach((g) => {
        g.status = "released";
        g.guaranteeReleasedAt = new Date();
      });
    }
  }

  if (updated) {
    await loan.save();
  }
};

/**
 * Process Loan Defaulter Escalation Engine
 */
const runLoanDefaulterEscalation = async () => {
  try {
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
    let guarantorDeductionsCount = 0;

    for (const loan of activeLoans) {
      const daysOverdue = getOldestOverdueDays(loan.installments);
      if (daysOverdue === 0) continue;

      // Execute automatic guarantor payment for overdue monthly dues
      await processGuarantorMonthlyDues(loan);
      guarantorDeductionsCount++;

      const user = await User.findById(loan.userId);
      if (!user) continue;

      // 1. Stage 1: 30 Days Late (Warning Notice)
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

      // 2. Stage 2: 60 Days Late (Account Restriction)
      else if (daysOverdue >= 60 && daysOverdue < 90 && loan.status !== "defaulted_60_days") {
        loan.status = "defaulted_60_days";
        await loan.save();

        // Restrict user status
        await User.findByIdAndUpdate(user._id, { status: "restricted" });
        restrictedCount++;

        await createNotification({
          userId: user._id,
          type: "loan",
          title: "🚫 Account Restricted: Loan Overdue (60 Days)",
          message: `Your loan repayment is 60 days overdue. Your account features have been restricted. Immediate payment required.`,
        });
      }

      // 3. Stage 3: 90 Days Late (Guarantor Notification)
      else if (daysOverdue >= 90 && daysOverdue < 120 && loan.status !== "restricted_90_days") {
        loan.status = "restricted_90_days";
        await loan.save();
        guarantorNotifiedCount++;

        // Notify member
        await createNotification({
          userId: user._id,
          type: "loan",
          title: "🚨 Guarantor Contacted: Loan Overdue (90 Days)",
          message: `Your loan repayment is 90 days overdue. Your guarantor has been formally notified regarding this debt.`,
        });

        // Notify Super Admin / Financial Managers to reach out to Guarantor
        const admins = await User.find({
          role: { $in: ["super_admin", "finance_manager"] },
          status: { $ne: "suspended" },
        }).select("_id");

        for (const admin of admins) {
          await createNotification({
            userId: admin._id,
            type: "system",
            title: "Guarantor Escalation Triggered",
            message: `Member ${user.fullName} is 90 days overdue on loan ₦${loan.remainingBalance.toLocaleString()}. Initiate guarantor recovery process.`,
            data: { loanId: loan._id, memberId: user._id },
          });
        }
      }

      // 4. Stage 4: 120 Days Late (Recovery Process Initiated)
      else if (daysOverdue >= 120 && loan.status !== "recovery_120_days") {
        loan.status = "recovery_120_days";
        await loan.save();
        recoveryCount++;

        await createNotification({
          userId: user._id,
          type: "loan",
          title: "⚖️ Legal Recovery Initiated: Loan Overdue (120 Days)",
          message: `Your loan is 120 days overdue. Your file has been transferred to the recovery department.`,
        });
      }
    }

    return {
      success: true,
      summary: {
        warningCount,
        restrictedCount,
        guarantorNotifiedCount,
        recoveryCount,
        guarantorDeductionsCount,
      },
    };
  } catch (error) {
    console.error("Error in runLoanDefaulterEscalation:", error);
    throw error;
  }
};

module.exports = { runLoanDefaulterEscalation, processGuarantorMonthlyDues };