const crypto = require("crypto");
const {
  PAYSTACK_PUBLIC_KEY,
  verifyPayment,
  initiateTransfer,
  verifyAccount,
  getBanks,
} = require("../Utilis/Paystack");
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
 * Uses the provider's transaction reference (flutterwaveRef field — kept
 * for backward compatibility, now holds the Paystack transaction id).
 */
const isTransactionAlreadyProcessed = async (providerRef, model = Savings) => {
  if (!providerRef) return false;
  const existing = await model.findOne({ flutterwaveRef: providerRef, status: "completed" });
  return !!existing;
};

/**
 * Mark a transaction as processed (set status to completed)
 * Optionally update the amount to the settled amount (net after fees).
 */
const markTransactionCompleted = async (model, id, providerRef, additionalData = {}) => {
  await model.findByIdAndUpdate(id, {
    status: "completed",
    flutterwaveRef: providerRef,
    ...additionalData,
  });
};

// ======================== DEPOSITS ========================

/**
 * POST /api/payments/deposit/initiate
 * Initiate a savings deposit via Paystack Popup (Inline JS on the frontend)
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
        publicKey: PAYSTACK_PUBLIC_KEY,

        reference,
        tx_ref: reference, // kept for any frontend code still reading tx_ref

        amount,
        amountKobo: Math.round(Number(amount) * 100),

        currency: "NGN",

        customer: {
          email: user?.email,
          name: user?.fullName,
        },

        customizations: {
          title: "Socket Moni",
          description: "Savings Deposit",
        },

        metadata: {
          userId: userId.toString(),
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
 * Frontend redirect callback after payment (only used if you adopt the
 * hosted-redirect flow instead of the Popup — harmless to keep either way).
 */
exports.paymentCallback = async (req, res) => {
  try {
    const { reference, tx_ref, status } = req.query;
    const ref = reference || tx_ref;

    if (!ref) {
      return res.redirect(`${process.env.FRONTEND_URL}/payments/savings/failed?reason=missing_reference`);
    }

    const params = [`reference=${encodeURIComponent(ref)}`, `tx_ref=${encodeURIComponent(ref)}`];

    const redirectBase =
      status === "success" || status === "successful"
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
    const { reference, tx_ref } = req.body;
    const ref = reference || tx_ref;

    if (!ref) {
      return res.status(400).json({ success: false, message: "Payment reference is required." });
    }

    const verification = await verifyPayment(ref);

    if (verification.status !== "success" || verification.data.status !== "successful") {
      return res.status(400).json({
        success: false,
        message: "Payment not successful",
      });
    }

    const existingSavings = await Savings.findOne({ reference: ref });
    if (!existingSavings) {
      return res.status(404).json({ success: false, message: "Deposit not found" });
    }
    if (existingSavings.status === "completed") {
      return res.json({ success: true, message: "Already verified" });
    }

    const settledAmount = verification.data.amount_settled || verification.data.amount || existingSavings.amount;

    // Atomic status transition from pending -> completed prevents race condition with webhook
    const savings = await Savings.findOneAndUpdate(
      { reference: ref, status: "pending" },
      {
        $set: {
          status: "completed",
          flutterwaveRef: String(verification.data.id),
          amount: settledAmount,
        },
      },
      { new: true }
    );

    if (!savings) {
      return res.json({ success: true, message: "Already verified" });
    }

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
        reference: ref,
      },
    });

    return res.json({
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
 * Paystack webhook handler — dispatches based on reference prefix.
 *
 * Signature verification: Paystack signs the RAW request body with
 * HMAC-SHA512 using the secret key, sent in the `x-paystack-signature`
 * header. This requires the exact raw bytes (req.rawBody, captured in
 * app.js's express.json() verify hook) — NOT JSON.stringify(req.body),
 * which is not guaranteed to reproduce the same bytes Paystack signed.
 *
 * Idempotency: checks flutterwaveRef (provider transaction id) to prevent
 * duplicate processing, since Paystack can and does deliver the same
 * webhook event more than once.
 */
exports.webhook = async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];

    if (!req.rawBody || !signature) {
      console.warn("Webhook: missing raw body or signature header");
      return res.status(401).json({ status: "unauthorized" });
    }

    const expectedSignature = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.rawBody)
      .digest("hex");

    const providedBuf = Buffer.from(signature, "utf8");
    const expectedBuf = Buffer.from(expectedSignature, "utf8");

    const signatureValid =
      providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);

    if (!signatureValid) {
      console.warn("Invalid webhook signature");
      return res.status(401).json({ status: "unauthorized" });
    }

    const event = req.body;
    const reference = event.data?.reference || null;

    if (!reference) {
      console.log("Webhook: No reference found, ignoring");
      return res.status(200).json({ status: "ignored" });
    }

    console.log(`Webhook received: ${event.event} | ref: ${reference}`);

    // Only act on successful charge events — everything else (transfer
    // events, etc.) either isn't handled yet or is handled elsewhere.
    if (event.event !== "charge.success" && event.event !== "transfer.success" && event.event !== "transfer.failed" && event.event !== "transfer.reversed") {
      return res.status(200).json({ status: "ignored" });
    }

    const normalizedData = {
      ...event.data,
      tx_ref: reference,
      status: event.event === "charge.success" ? "successful" : event.data?.status,
      amount_settled: typeof event.data?.amount === "number" ? event.data.amount / 100 : undefined,
      amount: typeof event.data?.amount === "number" ? event.data.amount / 100 : event.data?.amount,
    };

    // Process based on reference prefix
    if (reference.startsWith("DEP_")) {
      await handleDepositWebhook(normalizedData);
    } else if (reference.startsWith("WTH_")) {
      await handleWithdrawalWebhook(normalizedData);
    } else if (reference.startsWith("LNP_")) {
      await handleLoanPayoutWebhook(normalizedData);
    } else if (reference.startsWith("LRP_") || reference.startsWith("RPL_")) {
      await handleRepaymentWebhook(normalizedData);
    } else if (reference.startsWith("MEM_")) {
      await handleMembershipFeeWebhook(normalizedData);
    } else {
      console.log(`Unknown reference prefix: ${reference}`);
    }

    return res.status(200).json({ status: "success" });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ status: "error", message: err.message });
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

  // Atomic transition from pending -> completed
  const savings = await Savings.findOneAndUpdate(
    { reference, type: "deposit", status: "pending" },
    {
      $set: {
        status: status === "successful" ? "completed" : "failed",
        flutterwaveRef: String(transactionId),
        amount: settledAmount || undefined,
      },
    },
    { new: true }
  );

  if (!savings) {
    console.log(`Deposit webhook: ${reference} not found or already processed`);
    return;
  }

  if (status === "successful") {
    const finalAmount = settledAmount || savings.amount;
    await updateUserScore(savings.userId, "deposit");
    await createNotification({
      userId: savings.userId,
      type: "savings",
      title: "Deposit Successful",
      message: `Your deposit of ₦${finalAmount.toLocaleString()} was successful.`,
    });
    await logAudit({
      userId: savings.userId,
      action: "deposit",
      targetType: "savings",
      targetId: savings._id,
      details: { grossAmount, settledAmount: finalAmount, method: "paystack", reference },
    });
  } else {
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

  const withdrawal = await Savings.findOne({ reference, type: "withdrawal", status: "pending" });
  if (!withdrawal) {
    console.log(`Withdrawal webhook: ${reference} not found or already processed`);
    return;
  }

  if (withdrawal.flutterwaveRef && withdrawal.flutterwaveRef !== String(transferId)) {
    console.log(`Withdrawal webhook: ${reference} already has a different ref, skipping`);
    return;
  }

  if (status === "successful" || status === "success") {
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
      action: "withdrawal",
      targetType: "savings",
      targetId: withdrawal._id,
      details: { amount: settledAmount, method: "paystack_payout", reference },
    });
  } else {
    withdrawal.status = "failed";
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
  if (await isTransactionAlreadyProcessed(transferId, Loan, "payoutRef")) {
    console.log(`Loan payout webhook: ${transferId} already processed, skipping`);
    return;
  }

  const loan = await Loan.findOne({ payoutReference: reference });
  if (!loan) {
    console.log(`Loan payout webhook: ${reference} not found`);
    return;
  }

  if (loan.payoutRef && loan.payoutRef !== String(transferId)) {
    console.log(`Loan payout webhook: ${reference} already has a different ref, skipping`);
    return;
  }

  if (status === "successful" || status === "success") {
    loan.payoutStatus = "completed";
    loan.payoutRef = String(transferId);
    await loan.save();

    await createNotification({
      userId: loan.userId,
      type: "loan",
      title: "Loan Disbursed",
      message: `Your loan of ₦${loan.principalAmount.toLocaleString()} has been disbursed to your bank account.`,
    });
    await logAudit({
      userId: loan.userId,
      action: "loan_payout",
      targetType: "loan",
      targetId: loan._id,
      details: { principal: loan.principalAmount, settledAmount, reference },
    });
  } else {
    loan.payoutStatus = "failed";
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

  const repayment = await Savings.findOne({ reference, type: "loan_repayment", status: "pending" });
  if (!repayment) {
    console.log(`Repayment webhook: ${reference} not found or already processed`);
    return;
  }

  if (repayment.flutterwaveRef && repayment.flutterwaveRef !== String(transactionId)) {
    console.log(`Repayment webhook: ${reference} already has a different ref, skipping`);
    return;
  }

  if (status === "successful" || status === "success") {
    await markTransactionCompleted(Savings, repayment._id, transactionId, {
      amount: settledAmount || repayment.amount,
    });

    await processLoanRepayment({
      loanId: repayment.loanId,
      transactionId: String(transactionId),
      paymentAmount: settledAmount || repayment.amount,
      paymentReference: reference,
      paymentMethod: "paystack",
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
      action: "loan_repay",
      targetType: "loan",
      targetId: repayment.loanId,
      details: { amount: settledAmount || repayment.amount, reference },
    });
  } else {
    repayment.status = "failed";
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
  const MEMBERSHIP_FEE_AMOUNT = 1000;
  const reference = data.tx_ref || data.reference;
  const transactionId = data.id;
  const status = data.status;
  const amount = Number(data.amount_settled || data.amount || 0);

  // Ignore failed payments
  if (status !== "success") {
    console.log(`Membership payment failed: ${reference}`);
    return;
  }

  // Do not trust the frontend/webhook amount blindly — require the settled
  // amount to actually cover the membership fee before activating.
  if (amount < MEMBERSHIP_FEE_AMOUNT) {
    console.log(`Membership payment ${reference} settled for ₦${amount}, below required ₦${MEMBERSHIP_FEE_AMOUNT}. Not activating.`);
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
  user.membershipFeeTxRef = String(transactionId);

  await user.save();

  await createNotification({
    userId: user._id,
    type: "membership",
    title: "Membership Activated",
    message: "Your membership fee has been received successfully. Savings and loan features are now unlocked.",
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

// ======================== BANK VERIFICATION ========================

/**
 * POST /api/payments/verify-bank
 * Verify a bank account using Paystack
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
 * Get list of Nigerian banks from Paystack
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