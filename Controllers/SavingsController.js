const Savings = require("../Models/SavingsModel");
const User = require("../Models/UserModel");
const bcrypt = require("bcrypt");
// AFTER
const { createNotification } = require("../Utilis/notificationHelper");
const { updateUserScore } = require("../Utilis/scoreService");
const { 
  getTierBySavings, 
  getMinCommitmentForTier, 
  canUpgradeToTier 
} = require("../Utilis/tierService");


const {
  initializePayment,
  verifyPayment,
  PAYSTACK_PUBLIC_KEY,
} = require("../Utilis/Paystack");

const getNetSavings = async (userId) => {
  const completedSavings = await Savings.find({ userId, status: "completed" });
  return completedSavings.reduce((sum, item) => {
    if (item.type === "withdrawal") return sum - item.amount;
    if (item.type === "deposit") return sum + item.amount;
    return sum;
  }, 0);
};
/**
 * Calculates late payment penalty (2% monthly penalty as per PRD Section 7)
 */
const calculateLateLoanPenalty = (principalAmount, dueDate) => {
  const now = new Date();
  if (now <= new Date(dueDate)) {
    return 0; // Not late
  }
  
  // 2% penalty on overdue principal
  return Math.round(Number(principalAmount) * 0.02);
};

const getAverageMonthlySavings = async (userId) => {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  sixMonthsAgo.setHours(0,0,0,0);
  const deposits = await Savings.find({
    userId,
    type: "deposit",
    status: "completed",
    createdAt: { $gte: sixMonthsAgo },
  });
  if (deposits.length === 0) return 0;
  const monthMap = {};
  deposits.forEach(d => {
    const key = `${d.createdAt.getFullYear()}-${d.createdAt.getMonth()}`;
    monthMap[key] = (monthMap[key] || 0) + d.amount;
  });
  const total = Object.values(monthMap).reduce((a,b) => a+b, 0);
  const months = Object.keys(monthMap).length;
  return months > 0 ? total / months : 0;
};

const updateUserTierAndScore = async (userId, trigger = null) => {
  const avg = await getAverageMonthlySavings(userId);
  const newTier = getTierBySavings(avg);
  const user = await User.findById(userId);
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
  await updateUserScore(userId, trigger || (tierChanged ? 'tier_update' : 'savings_update'));
  if (tierChanged) await user.save();
};

const getSavingsSummary = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const savingsList = await Savings.find({ userId, status: "completed" }).sort({ createdAt: -1 });
    const totalSaved = savingsList.reduce((acc, curr) => {
      if (curr.type === "withdrawal") return acc - curr.amount;
      if (curr.type === "deposit") return acc + curr.amount;
      return acc;
    }, 0);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const monthlyContributed = savingsList
      .filter((s) => s.type === "deposit" && new Date(s.createdAt) >= startOfMonth)
      .reduce((acc, curr) => acc + curr.amount, 0);

    const user = await User.findById(userId).select("tier monthlySavingsCommitment");
    
    // Tier-based commitment (fallback to tier minimum if not explicitly set)
    const activeTier = user?.tier || "Bronze";
    const tierMin = getMinCommitmentForTier(activeTier);
    const commitment = user?.monthlySavingsCommitment > 0 ? user.monthlySavingsCommitment : tierMin;

    const monthCompletion = Math.min(100, Math.round((monthlyContributed / commitment) * 100));

    return res.status(200).json({
      success: true,
      summary: {
        totalSaved,
        currentTier: activeTier,
        monthlyTarget: commitment,
        monthlyContributed,
        monthCompletion,
        isTierTargetMet: monthlyContributed >= commitment,
        growthRatePct: 12.4,
      },
    });
  } catch (error) { 
    next(error); 
  }
};




const getMonthlySavingsReport = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const now = new Date();
    const savingsList = await Savings.find({ userId, status: "completed" });
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthlyReportMap = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = monthNames[d.getMonth()];
      monthlyReportMap[label] = 0;
    }
    savingsList.forEach((s) => {
      const d = new Date(s.createdAt);
      const label = monthNames[d.getMonth()];
      if (monthlyReportMap[label] !== undefined) {
        monthlyReportMap[label] += s.amount;
      }
    });
    const report = Object.keys(monthlyReportMap).map((month) => ({ month, amount: monthlyReportMap[month] }));
    return res.status(200).json({ success: true, data: report });
  } catch (error) { next(error); }
};

const getSavingsHistory = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const total = await Savings.countDocuments({ userId });
    const savingsList = await Savings.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const history = savingsList.map((item) => ({
      id: item._id,
      date: item.createdAt.toISOString().split("T")[0],
      amount: item.amount,
      type: item.type,
      method: item.method,
      status: item.status,
    }));
    return res.status(200).json({
      success: true,
      data: history,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) { next(error); }
};

const withdrawFromSavings = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { amount, method, bankDetails, pin } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Please enter a valid amount." });
    }

    const user = await User.findById(userId);
    if (!user || !user.transactionPin) {
      return res.status(400).json({ success: false, message: "Transaction PIN not set." });
    }

    // Verify transaction PIN
    const isPinValid = await bcrypt.compare(pin, user.transactionPin);
    if (!isPinValid) {
      return res.status(400).json({ success: false, message: "Invalid transaction PIN." });
    }

    const netSavings = await getNetSavings(userId);
    const standardFee = 100; // Standard processing fee
    const totalDeduction = Number(amount) + standardFee;

    if (netSavings < totalDeduction) {
      return res.status(400).json({
        success: false,
        message: `Insufficient savings balance. Available: ₦${netSavings.toLocaleString()}. Total required (including ₦${standardFee} fee): ₦${totalDeduction.toLocaleString()}`,
      });
    }

    const withdrawal = await Savings.create({
      userId,
      amount: totalDeduction,
      type: "withdrawal",
      method: method || "Bank Transfer",
      status: "completed",
      fee: standardFee,
      reference: `WTH-${Date.now()}`,
    });

    await updateUserTierAndScore(userId, "withdrawal");

    // Member Notification
    await createNotification({
      userId,
      type: "savings",
      title: "Withdrawal Successful",
      message: `Withdrew ₦${Number(amount).toLocaleString()} from your savings account. Fee: ₦${standardFee}`,
    });

    return res.status(200).json({
      success: true,
      message: "Withdrawal processed successfully.",
      data: {
        withdrawalId: withdrawal._id,
        payoutAmount: Number(amount),
        fee: standardFee,
        totalDeducted: totalDeduction,
        newBalance: netSavings - totalDeduction,
        reference: withdrawal.reference,
        destinationBank: bankDetails || user.bankDetails,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/savings/withdraw-request
 * Member requests a withdrawal (goes to pending_approval)
 * Notifies both the user and all admins.
 */
const requestWithdrawal = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { amount, accountNumber, accountName, bankName, pin } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Please enter a valid amount." });
    }
    if (!bankName || !accountName || !/^\d{10}$/.test(accountNumber || "")) {
      return res.status(400).json({ success: false, message: "Bank details are required." });
    }

    // Check sufficient balance (including fee)
    const netSavings = await getNetSavings(userId);
    const fee = 100;
    const totalDeduction = Number(amount) + fee;
    if (netSavings < totalDeduction) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: ₦${netSavings.toLocaleString()}`,
      });
    }

    // Verify transaction PIN and ensure the destination matches the saved profile.
    const user = await User.findById(userId);
    if (!user || !user.transactionPin) {
      return res.status(400).json({ success: false, message: "Transaction PIN not set." });
    }
    const savedBankDetails = user.bankDetails || {};
    if (
      savedBankDetails.accountNumber !== accountNumber ||
      savedBankDetails.accountName !== accountName ||
      savedBankDetails.bankName !== bankName
    ) {
      return res.status(400).json({ success: false, message: "Withdrawal bank details must match your saved profile details." });
    }
    const isPinValid = await bcrypt.compare(pin, user.transactionPin);
    if (!isPinValid) {
      return res.status(400).json({ success: false, message: "Invalid transaction PIN." });
    }

    // Create withdrawal request (pending approval)
    const withdrawalRequest = await Savings.create({
      userId,
      amount: Number(amount),
      type: "withdrawal",
      method: "flutterwave_payout",
      status: "pending_approval",
      fee: fee,
      reference: `WTH_REQ_${Date.now()}`,
      bankDetails: {
        bankCode: user.bankDetails?.bankCode || null,
        bankName: savedBankDetails.bankName,
        accountNumber: savedBankDetails.accountNumber,
        accountName: savedBankDetails.accountName,
      },
    });

    // Notify the user
    await createNotification({
      userId: userId,
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

    // Notify all admins (super_admin, finance_manager)
    const admins = await User.find({ 
      role: { $in: ["super_admin", "finance_manager"] },
      status: { $ne: "suspended" }
    }).select("_id");

    for (const admin of admins) {
      await createNotification({
        userId: admin._id,
        type: "system",
        title: "New Withdrawal Request",
        message: `${user.fullName} has requested a withdrawal of ₦${Number(amount).toLocaleString()}.`,
        data: { withdrawalId: withdrawalRequest._id, userId: user._id },
      });
    }

    return res.status(201).json({
      success: true,
      message: "Withdrawal request submitted for approval.",
      data: {
        withdrawalId: withdrawalRequest._id,
        status: withdrawalRequest.status,
      },
    });
  } catch (error) {
    next(error);
  }
};


// PRD Section 3: Configurable Membership Fee (Default ₦1,000)
const MEMBERSHIP_FEE_AMOUNT = 1000; 

/**
 * 1. Initialize Membership Fee Payment
 */
// AFTER
const initializeMembershipFee = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (user.membershipFeePaid) {
      return res.status(400).json({
        success: false,
        message: "Membership fee has already been paid for this account."
      });
    }

    // Unique transaction reference for Paystack
    const tx_ref = `MEM_${Date.now()}_${user._id}`;

    // Save reference BEFORE opening the Paystack popup
    user.membershipFeeTxRef = tx_ref;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Membership fee payment initialized.",
      data: {
        publicKey: PAYSTACK_PUBLIC_KEY,
        reference: tx_ref,
        tx_ref, // kept for any frontend code still reading tx_ref
        amount: MEMBERSHIP_FEE_AMOUNT,
        amountKobo: Math.round(MEMBERSHIP_FEE_AMOUNT * 100),
        currency: "NGN",
        customer: {
          email: user.email,
          name: user.fullName,
          phone_number: user.phone || "",
        },
        customizations: {
          title: "SocketMonnie Membership Fee",
          description: "Pay 1000 NGN to continue using the service.",
          logo: process.env.APP_LOGO || "",
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 2. Verify Membership Fee Payment (Callback / Direct Verification)
 */
const verifyMembershipFee = async (req, res, next) => {
  try {
    const { reference, tx_ref, transaction_id } = req.body;

    // Paystack verifies by `reference` -- accept whichever field name the
    // frontend is still sending during rollout.
    const paymentRef = reference || tx_ref || transaction_id;

    if (!paymentRef) {
      return res.status(400).json({
        success: false,
        message: "Payment reference is required."
      });
    }

    // Call Paystack verification service
    const verification = await verifyPayment(paymentRef);

    const payment = verification.data;
    if (payment.tx_ref !== paymentRef) {
      return res.status(400).json({
        success: false,
        message: "Invalid transaction reference"
      });
    }

    if (
      verification.status === "success" &&
      payment.status === "successful"
    ) {
      // Do NOT trust the frontend/checkout amount blindly. The frontend
      // amount that gets handed to the Paystack popup is fully editable in
      // the browser before the popup opens, so the only trustworthy amount
      // is what Paystack itself confirms was actually settled.
      const amountPaid = Number(payment.amount_settled ?? payment.amount ?? 0);

      if (amountPaid < MEMBERSHIP_FEE_AMOUNT) {
        return res.status(400).json({
          success: false,
          message: `Payment amount (₦${amountPaid.toLocaleString()}) is less than the required membership fee of ₦${MEMBERSHIP_FEE_AMOUNT.toLocaleString()}.`,
        });
      }

      const userId = req.user._id;
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found." });
      }

      // Idempotency check
      if (user.membershipFeePaid) {
        return res.status(200).json({
          success: true,
          message: "Membership fee already recorded as paid.",
          data: { membershipFeePaid: true },
        });
      }

      // Unlock member account
      user.membershipFeePaid = true;
      user.membershipFeeTxRef = paymentRef;
      user.membershipFeePaidAt = new Date();
      await user.save();

      return res.status(200).json({
        success: true,
        message: "Membership fee verified successfully! Cooperative features unlocked.",
        data: {
          membershipFeePaid: true,
          membershipFeePaidAt: user.membershipFeePaidAt,
        },
      });
    } else {
      return res.status(400).json({
        success: false,
        message: "Payment verification failed or insufficient amount.",
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Update Tier & Monthly Commitment (With KYC Check)
 */
/**
 * Update Tier & Monthly Commitment (With KYC Check)
 */
const updateTierCommitment = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { newTier, newCommitment } = req.body;

    const targetTierKey = (newTier || "").toLowerCase();
    const validTiers = ["bronze", "silver", "gold", "platinum"];

    if (!validTiers.includes(targetTierKey)) {
      return res.status(400).json({ success: false, message: "Invalid membership tier selected." });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // Check KYC & Tier prerequisites
    const upgradeCheck = canUpgradeToTier(user, targetTierKey);
    if (!upgradeCheck.canUpgrade) {
      return res.status(400).json({
        success: false,
        message: "Cannot upgrade tier at this time.",
        reasons: upgradeCheck.reasons,
      });
    }

    // Validate amount against tier minimum
    const minRequired = getMinCommitmentForTier(targetTierKey);
    if (newCommitment < minRequired) {
      return res.status(400).json({
        success: false,
        message: `Minimum monthly commitment for ${targetTierKey.toUpperCase()} tier is ₦${minRequired.toLocaleString()}.`,
      });
    }

    const formattedTier = targetTierKey.charAt(0).toUpperCase() + targetTierKey.slice(1);
    user.tier = formattedTier;
    user.monthlySavingsCommitment = newCommitment;
    await user.save();

    return res.status(200).json({
      success: true,
      message: `Successfully upgraded to ${formattedTier} Tier! Your new monthly target is ₦${newCommitment.toLocaleString()}.`,
      data: {
        tier: user.tier,
        monthlySavingsCommitment: user.monthlySavingsCommitment,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
    getSavingsSummary,
  
    getMonthlySavingsReport,
    getSavingsHistory,
    withdrawFromSavings,
    requestWithdrawal,
    initializeMembershipFee,
    verifyMembershipFee,
    updateTierCommitment,
};