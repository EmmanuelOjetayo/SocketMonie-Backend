const {
  initializePayment,
  verifyPayment,
  initiateTransfer,
  verifyAccount,
  getBanks
} = require("../Utilis/flutterwave");
const { processLoanRepayment } = require("../Controllers/LoanController");
const Savings = require("../Models/SavingsModel");
const User = require("../Models/UserModel");
const Loan = require("../Models/LoanModel");
const { createNotification } = require("../Utilis/notificationHelper");
const { updateUserScore } = require("../Utilis/scoreService");
const { logAudit } = require("../Utilis/auditLogger");

// ======================== IDEMPOTENCY HELPERS ========================

/**
 * Check if a transaction has already been processed successfully.
 * Uses flutterwaveRef to avoid duplicate processing.
 */
const isTransactionAlreadyProcessed = async (flutterwaveRef, model = Savings) => {
  if (!flutterwaveRef) return false;
  const existing = await model.findOne({ flutterwaveRef, status: 'completed' });
  return !!existing;
};

/**
 * Mark a transaction as processed (set status to completed)
 * Optionally update the amount to the settled amount (net after fees).
 */
const markTransactionCompleted = async (model, id, flutterwaveRef, additionalData = {}) => {
  await model.findByIdAndUpdate(id, {
    status: 'completed',
    flutterwaveRef,
    ...additionalData,
  });
};

// ======================== DEPOSITS ========================

/**
 * POST /api/payments/deposit/initiate
 * Initiate a savings deposit via Flutterwave
 */
exports.initiateDeposit = async (req, res) => {
  try {
    const { amount, method } = req.body;

    const userId = req.user._id;

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const reference = `DEP_${Date.now()}_${userId.toString().slice(-6)}`;

    const pendingDeposit = await Savings.create({
      userId,
      amount,
      method,
      status: "pending",
      type: "deposit",
      reference,
    });

    res.json({
      success: true,
      data: {
        publicKey: process.env.FLW_PUBLIC_KEY,

        tx_ref: reference,

        amount,

        currency: "NGN",

        customer: {
          email: user?.email,
          name: user?.fullName,

        },

        customizations: {
          title: "Socket Moni",
          description: "Savings Deposit",
        },

        meta: {
          userId,
          type: "deposit",
        },

        transactionId: pendingDeposit._id,
      },
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/**
 * GET /api/payments/deposit/callback
 * Frontend redirect callback after payment
 */
exports.paymentCallback = async (req, res) => {
  try {
    const { transaction_id, status, tx_ref } = req.query;

    if (!tx_ref) {
      return res.redirect(`${process.env.FRONTEND_URL}/payments/savings/failed?reason=missing_reference`);
    }

    const params = [`tx_ref=${encodeURIComponent(tx_ref)}`];
    if (transaction_id) {
      params.push(`transaction_id=${encodeURIComponent(transaction_id)}`);
    }

    const redirectBase =
      status === "successful"
        ? `${process.env.FRONTEND_URL}/payments/savings/success`
        : `${process.env.FRONTEND_URL}/payments/savings/failed`;

    return res.redirect(`${redirectBase}?${params.join("&")}`);
  } catch (err) {
    console.error("Callback error:", err);
    return res.redirect(`${process.env.FRONTEND_URL}/payments/savings/failed?reason=callback_error`);
  }
};

exports.verifyDeposit = async (req, res) => {
  try {
    const { transaction_id, tx_ref } = req.body;

    const verification = await verifyPayment(transaction_id);

    if (
      verification.status !== "success" ||
      verification.data.status !== "successful"
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment not successful",
      });
    }

    const savings = await Savings.findOne({
      reference: tx_ref,
    });

    if (!savings) {
      return res.status(404).json({
        success: false,
        message: "Deposit not found",
      });
    }

    if (savings.status === "completed") {
      return res.json({
        success: true,
        message: "Already verified",
      });
    }

    const settledAmount =
      verification.data.amount_settled || verification.data.amount || savings.amount;

    savings.status = "completed";
    savings.flutterwaveRef = transaction_id;
    savings.amount = settledAmount;

    await savings.save();

    await updateUserScore(savings.userId, "deposit");

    await createNotification({
      userId: savings.userId,
      type: "savings",
      title: "Deposit Successful",
      message: `Your deposit of ₦${savings.amount.toLocaleString()} was successful.`,
    });

    await logAudit({
      userId: savings.userId,
      action: "deposit",
      targetType: "savings",
      targetId: savings._id,
      details: {
        amount: savings.amount,
        reference: tx_ref,
      },
    });

    res.json({
      success: true,
      message: "Verified successfully",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
// ======================== WEBHOOK ========================

/**
 * POST /api/payments/webhook
 * Flutterwave webhook handler – dispatches based on reference prefix
 * Idempotency: checks flutterwaveRef to prevent duplicate processing.
 */
exports.webhook = async (req, res) => {
  try {
    const event = req.body;
    const signature = req.headers['verif-hash'];

    // Verify webhook signature
    if (signature !== process.env.FLW_WEBHOOK_SECRET) {
      console.warn("Invalid webhook signature");
      return res.status(401).json({ status: 'unauthorized' });
    }

    const reference = event.data?.tx_ref || event.data?.reference || null;
    if (!reference) {
      console.log("Webhook: No reference found, ignoring");
      return res.status(200).json({ status: 'ignored' });
    }

    console.log(`Webhook received: ${event.event} | ref: ${reference}`);

    // Process based on prefix
   if (reference.startsWith("DEP_")) {
  await handleDepositWebhook(event.data);

} else if (reference.startsWith("WTH_")) {
  await handleWithdrawalWebhook(event.data);

} else if (reference.startsWith("LNP_")) {
  await handleLoanPayoutWebhook(event.data);

} else if (reference.startsWith("RPL_")) {
  await handleRepaymentWebhook(event.data);

} else if (reference.startsWith("MEM_")) {
  await handleMembershipFeeWebhook(event.data);

} else {
  console.log(`Unknown reference prefix: ${reference}`);
}

    return res.status(200).json({ status: 'success' });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
};

// ======================== WEBHOOK HANDLERS (with Idempotency & Settled Amount) ========================

async function handleDepositWebhook(data) {
  const reference = data.tx_ref || data.reference;
  const transactionId = data.id;
  const status = data.status;
  const grossAmount = data.amount;
  const settledAmount = data.amount_settled || data.amount;

  if (!transactionId || !reference) {
    console.log("Deposit webhook: missing transaction id or reference");
    return;
  }

  // Idempotency: check if already processed
  if (await isTransactionAlreadyProcessed(transactionId, Savings)) {
    console.log(`Deposit webhook: ${transactionId} already processed, skipping`);
    return;
  }

  const savings = await Savings.findOne({ reference, type: 'deposit' });
  if (!savings || savings.status !== 'pending') {
    console.log(`Deposit webhook: ${reference} not found or already processed`);
    return;
  }

  if (savings.flutterwaveRef && savings.flutterwaveRef !== transactionId) {
    console.log(`Deposit webhook: ${reference} already has a different ref, skipping`);
    return;
  }

  if (status === 'successful') {
    const finalAmount = settledAmount || savings.amount;
    await markTransactionCompleted(Savings, savings._id, transactionId, { amount: finalAmount });
    await updateUserScore(savings.userId, 'deposit');
    await createNotification({
      userId: savings.userId,
      type: "savings",
      title: "Deposit Successful",
      message: `Your deposit of ₦${finalAmount.toLocaleString()} was successful.`,
    });
    await logAudit({
      userId: savings.userId,
      action: 'deposit',
      targetType: 'savings',
      targetId: savings._id,
      details: { grossAmount, settledAmount: finalAmount, method: 'flutterwave', reference },
    });
  } else {
    savings.status = 'failed';
    await savings.save();
    await createNotification({
      userId: savings.userId,
      type: "savings",
      title: "Deposit Failed",
      message: `Your deposit of ₦${grossAmount?.toLocaleString() || 0} failed. Please try again.`,
    });
  }
}

async function handleWithdrawalWebhook(data) {
  const reference = data.reference || data.tx_ref;
  const status = data.status;
  const transferId = data.id;
  const settledAmount = data.amount; // For transfers, amount is the net settled

  // Idempotency: check if already processed
  if (await isTransactionAlreadyProcessed(transferId, Savings)) {
    console.log(`Withdrawal webhook: ${transferId} already processed, skipping`);
    return;
  }

  const withdrawal = await Savings.findOne({ reference, type: 'withdrawal', status: 'pending' });
  if (!withdrawal) {
    console.log(`Withdrawal webhook: ${reference} not found or already processed`);
    return;
  }

  if (withdrawal.flutterwaveRef && withdrawal.flutterwaveRef !== transferId) {
    console.log(`Withdrawal webhook: ${reference} already has a different ref, skipping`);
    return;
  }

  if (status === 'successful') {
    // Update amount to settled amount if it differs
    await markTransactionCompleted(Savings, withdrawal._id, transferId, { amount: settledAmount });
    await createNotification({
      userId: withdrawal.userId,
      type: "savings",
      title: "Withdrawal Successful",
      message: `Your withdrawal of ₦${settledAmount.toLocaleString()} was successful.`,
      data: {
        action: "withdrawal_successful",
        withdrawalId: withdrawal._id,
        amount: settledAmount,
        fee: withdrawal.fee || 0,
        totalDeducted: settledAmount + (withdrawal.fee || 0),
        destinationBank: withdrawal.bankDetails,
        status: "completed",
        reference,
      },
    });
    await logAudit({
      userId: withdrawal.userId,
      action: 'withdrawal',
      targetType: 'savings',
      targetId: withdrawal._id,
      details: { amount: settledAmount, method: 'flutterwave_payout', reference },
    });
  } else {
    withdrawal.status = 'failed';
    await withdrawal.save();
    await createNotification({
      userId: withdrawal.userId,
      type: "savings",
      title: "Withdrawal Failed",
      message: `Your withdrawal of ₦${settledAmount.toLocaleString()} failed. Please try again or contact support.`,
      data: {
        action: "withdrawal_failed",
        withdrawalId: withdrawal._id,
        amount: settledAmount,
        fee: withdrawal.fee || 0,
        totalDeducted: 0,
        destinationBank: withdrawal.bankDetails,
        status: "failed",
        reference,
      },
    });
  }
}

async function handleLoanPayoutWebhook(data) {
  const reference = data.reference || data.tx_ref;
  const status = data.status;
  const transferId = data.id;
  const settledAmount = data.amount;

  // Idempotency: check if already processed
  if (await isTransactionAlreadyProcessed(transferId, Loan, 'payoutRef')) {
    console.log(`Loan payout webhook: ${transferId} already processed, skipping`);
    return;
  }

  const loan = await Loan.findOne({ payoutReference: reference });
  if (!loan) {
    console.log(`Loan payout webhook: ${reference} not found`);
    return;
  }

  if (loan.payoutRef && loan.payoutRef !== transferId) {
    console.log(`Loan payout webhook: ${reference} already has a different ref, skipping`);
    return;
  }

  if (status === 'successful') {
    loan.payoutStatus = 'completed';
    loan.payoutRef = transferId;
    // If the settled amount differs from principal, we might want to log it, but we keep principal as is.
    await loan.save();

    await createNotification({
      userId: loan.userId,
      type: "loan",
      title: "Loan Disbursed",
      message: `Your loan of ₦${loan.principalAmount.toLocaleString()} has been disbursed to your bank account.`,
    });
    await logAudit({
      userId: loan.userId,
      action: 'loan_payout',
      targetType: 'loan',
      targetId: loan._id,
      details: { principal: loan.principalAmount, settledAmount, reference },
    });
  } else {
    loan.payoutStatus = 'failed';
    await loan.save();
    await createNotification({
      userId: loan.userId,
      type: "loan",
      title: "Loan Disbursement Failed",
      message: `The disbursement of your loan of ₦${loan.principalAmount.toLocaleString()} failed. Please contact support.`,
    });
  }
}

async function handleRepaymentWebhook(data) {
  const reference = data.tx_ref || data.reference;
  const status = data.status;
  const transactionId = data.id;
  const settledAmount = data.amount_settled || data.amount;

  if (!transactionId || !reference) {
    console.log("Repayment webhook: missing transaction id or reference");
    return;
  }

  // Idempotency: check if already processed
  if (await isTransactionAlreadyProcessed(transactionId, Savings)) {
    console.log(`Repayment webhook: ${transactionId} already processed, skipping`);
    return;
  }

  const repayment = await Savings.findOne({ reference, type: 'loan_repayment', status: 'pending' });
  if (!repayment) {
    console.log(`Repayment webhook: ${reference} not found or already processed`);
    return;
  }

  if (repayment.flutterwaveRef && repayment.flutterwaveRef !== transactionId) {
    console.log(`Repayment webhook: ${reference} already has a different ref, skipping`);
    return;
  }

  if (status === 'successful') {
    await markTransactionCompleted(Savings, repayment._id, transactionId, {
      amount: settledAmount || repayment.amount,
    });

    await processLoanRepayment({
      loanId: repayment.loanId,
      transactionId,
      paymentAmount: settledAmount || repayment.amount,
      paymentReference: reference,
      paymentMethod: 'flutterwave',
      verifiedData: data,
    });

    await createNotification({
      userId: repayment.userId,
      type: "loan",
      title: "Loan Repayment Successful",
      message: `Your loan repayment of ₦${(settledAmount || repayment.amount).toLocaleString()} was successful.`,
    });
    await logAudit({
      userId: repayment.userId,
      action: 'loan_repay',
      targetType: 'loan',
      targetId: repayment.loanId,
      details: { amount: settledAmount || repayment.amount, reference },
    });
  } else {
    repayment.status = 'failed';
    await repayment.save();
    await createNotification({
      userId: repayment.userId,
      type: "loan",
      title: "Loan Repayment Failed",
      message: `Your loan repayment of ₦${(settledAmount || repayment.amount).toLocaleString()} failed. Please try again.`,
    });
  }
}
async function handleMembershipFeeWebhook(data) {
  const reference = data.tx_ref || data.reference;
  const transactionId = data.id;
  const status = data.status;
  const amount = Number(data.amount_settled || data.amount || 0);

  // Ignore failed payments
  if (status !== "successful") {
    console.log(`Membership payment failed: ${reference}`);
    return;
  }

  // Find user by tx_ref
  const user = await User.findOne({
    membershipFeeTxRef: reference,
  });

  if (!user) {
    console.log(`Membership payment not found: ${reference}`);
    return;
  }

  // Already processed
  if (user.membershipFeePaid) {
    console.log(`Membership already activated: ${reference}`);
    return;
  }

  user.membershipFeePaid = true;
  user.membershipFeePaidAt = new Date();
  user.membershipFeeTxRef = transactionId;

  await user.save();

  await createNotification({
    userId: user._id,
    type: "membership",
    title: "Membership Activated",
    message:
      "Your membership fee has been received successfully. Savings and loan features are now unlocked.",
  });

  await logAudit({
    userId: user._id,
    action: "membership_fee_paid",
    targetType: "membership",
    targetId: user._id,
    details: {
      reference,
      transactionId,
      amount,
    },
  });

  console.log(`Membership activated for ${user.email}`);
}

// ======================== WITHDRAWAL PAYOUT ========================

/**
 * POST /api/payments/withdraw/payout
 * Initiate a withdrawal payout (admin/finance manager action)
 */
// exports.initiateWithdrawalPayout = async (req, res) => {
//   try {
//     const { withdrawalId, accountBank, accountNumber, amount } = req.body;

//     const withdrawal = await Savings.findById(withdrawalId);
//     if (!withdrawal) {
//       return res.status(404).json({ success: false, message: "Withdrawal not found." });
//     }
//     if (withdrawal.status !== 'approved') {
//       return res.status(400).json({ success: false, message: "Withdrawal is not approved yet." });
//     }

//     const user = await User.findById(withdrawal.userId);
//     if (!user) {
//       return res.status(404).json({ success: false, message: "User not found." });
//     }

//     const reference = `WTH_${Date.now()}_${withdrawal.userId.toString().slice(-6)}`;

//     const transfer = await initiateTransfer(
//       accountBank,
//       accountNumber,
//       amount,
//       reference,
//       `Socket Moni Withdrawal - ${user.fullName}`
//     );

//     withdrawal.reference = reference;
//     withdrawal.flutterwaveRef = transfer.data?.id || null;
//     withdrawal.status = 'pending'; // Wait for webhook confirmation
//     await withdrawal.save();

//     return res.status(200).json({
//       success: true,
//       message: "Payout initiated.",
//       data: {
//         reference,
//         transferId: transfer.data?.id,
//         status: transfer.data?.status,
//       },
//     });
//   } catch (err) {
//     console.error("Payout error:", err);
//     return res.status(500).json({ success: false, message: err.message || "Failed to initiate payout" });
//   }
// };

// ======================== BANK VERIFICATION ========================

/**
 * POST /api/payments/verify-bank
 * Verify a bank account using Flutterwave
 */
exports.verifyBankAccount = async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;
    if (!accountNumber || !bankCode) {
      return res.status(400).json({ success: false, message: "Account number and bank code are required." });
    }

    const result = await verifyAccount(accountNumber, bankCode);
    return res.status(200).json({
      success: true,
      data: {
        accountNumber: result.data.account_number,
        accountName: result.data.account_name,
        bankCode: result.data.bank_code,
      },
    });
  } catch (err) {
    console.error("Bank verification error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to verify bank account" });
  }
};

/**
 * GET /api/payments/banks
 * Get list of Nigerian banks from Flutterwave
 */
exports.getBanksList = async (req, res) => {
  try {
    const result = await getBanks();
    return res.status(200).json({
      success: true,
      data: result.data,
    });
  } catch (err) {
    console.error("Get banks error:", err);
    return res.status(500).json({ success: false, message: err.message || "Failed to fetch banks" });
  }
};

// In PaymentController.js

/**
 * POST /api/payments/loan/repay/initiate
 * Member initiates loan repayment via Flutterwave
 */
