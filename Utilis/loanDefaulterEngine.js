const Loan = require("../Models/LoanModel");
const User = require("../Models/UserModel");
const SystemSettings = require("../Models/SystemSettingsModel");
const { createNotification } = require("./notificationHelper");

/**
 * Helper: Find the oldest overdue installment for a loan
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

    for (const loan of activeLoans) {
      const daysOverdue = getOldestOverdueDays(loan.installments);
      if (daysOverdue === 0) continue;

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
          // AFTER
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
      },
    };
  } catch (error) {
    console.error("Error in runLoanDefaulterEscalation:", error);
    throw error;
  }
};

module.exports = { runLoanDefaulterEscalation };