const crypto = require("crypto");
const mongoose = require("mongoose");
const { PaymentRepository } = require("../Repositories/PaymentRepository");
const { FLW_PUBLIC_KEY, FLW_SUBACCOUNT_ID, verifyPayment, verifyTransactionById, verifyAccount, getBanks } = require("../Utilis/Flutterwave");
const { processLoanRepayment } = require("../Services/LoanService");
const { createNotification } = require("../Utilis/notificationHelper");
const { updateUserScore } = require("../Utilis/scoreService");
const { logAudit } = require("../Utilis/auditLogger");
const { FinancialLedgerService } = require("./FinancialLedgerService");
const AppError = require("../Utilis/AppError");
const { MEMBERSHIP_FEE_AMOUNT } = require("../Config/constants");

const initiateDeposit = async (userId, amount, method) => {
  const user = await PaymentRepository.findUser(userId);
  if (!user) throw new AppError("User not found", 404);

  const reference = `DEP_${Date.now()}_${userId.toString().slice(-6)}`;
  const pendingDeposit = await PaymentRepository.createPendingDeposit({
    userId,
    amount,
    method: method || "flutterwave",
    status: "pending",
    type: "deposit",
    reference,
  });

  return {
    publicKey: FLW_PUBLIC_KEY,
    public_key: FLW_PUBLIC_KEY,
    reference,
    tx_ref: reference,
    txRef: reference,
    amount,
    currency: "NGN",
    customer: { email: user.email, name: user.fullName, phone_number: user.phone || "" },
    customizations: { title: "SocketMonnie", description: "Savings Deposit" },
    meta: { userId: userId.toString(), type: "deposit" },
    metadata: { userId: userId.toString(), type: "deposit" },
    // Split-payment subaccount — present ONLY in this one-time checkout payload.
    subaccount_id: FLW_SUBACCOUNT_ID || undefined,
    transactionId: pendingDeposit._id,
  };
};

const resolveVerification = async ({ ref, transactionId }) => {
  // Prefer the authoritative numeric Flutterwave transaction id when supplied.
  if (transactionId && /^\d+$/.test(String(transactionId).trim())) {
    const byId = await verifyTransactionById(String(transactionId).trim());
    return byId;
  }
  if (!ref) throw new AppError("Payment reference is required.", 400);
  return verifyPayment(ref);
};

const assertFlwSuccess = (verification) => {
  if (!verification || verification.status !== "success") {
    throw new AppError("Unable to verify payment with Flutterwave.", 400);
  }
  const data = verification.data || {};
  const status = String(data.status || "").toLowerCase();
  if (status !== "successful") {
    throw new AppError(`Payment not successful. Status: ${data.status || "unknown"}`, 400);
  }
  return data;
};

const verifyDeposit = async (userId, ref, transactionId) => {
  if (!ref && !transactionId) throw new AppError("Payment reference is required.", 400);

  const verification = await resolveVerification({ ref, transactionId });
  const data = assertFlwSuccess(verification);

  const flwTxRef = String(data.tx_ref || data.reference || ref || "").trim();
  // The tx_ref returned by Flutterwave must match an expected SocketMonnie reference.
  if (ref && flwTxRef && flwTxRef !== String(ref).trim()) {
    throw new AppError("Payment reference mismatch.", 400);
  }
  if (String(data.currency || "NGN").toUpperCase() !== "NGN") {
    throw new AppError("Currency mismatch.", 400);
  }

  const lookupRef = flwTxRef || String(ref).trim();
  const existingSavings = await PaymentRepository.findSavingsByReference(lookupRef);
  if (!existingSavings) {
    throw new AppError("Deposit not found", 404);
  }
  if (existingSavings.status === "completed") {
    return { alreadyVerified: true };
  }
  // Ownership: the pending deposit must belong to the caller.
  if (String(existingSavings.userId) !== String(userId)) {
    throw new AppError("This transaction does not belong to your account.", 403);
  }
  // Amount: Flutterwave amount (major units) must cover the expected amount.
  const paidAmount = Number(data.charged_amount ?? data.amount ?? 0);
  if (!paidAmount || paidAmount < Number(existingSavings.amount || 0)) {
    throw new AppError(
      `Amount mismatch. Expected ₦${Number(existingSavings.amount || 0).toLocaleString()}, received ₦${paidAmount.toLocaleString()}.`,
      400
    );
  }

  const settledAmount = Number(data.amount_settled ?? data.amount ?? existingSavings.amount);

  const session = await mongoose.startSession();
  let savings;
  try {
    await session.withTransaction(async () => {
      savings = await PaymentRepository.findAndCompleteDeposit(lookupRef, {
        status: "completed",
        flutterwaveRef: String(data.id),
        transactionId: String(data.id),
        flwRef: data.flw_ref || undefined,
        amount: settledAmount,
      }, session);
      if (!savings) return;
      await FinancialLedgerService.recordEntry({
        entryType: "inflow",
        accountCategory: "member_savings",
        activityType: "savings_deposit",
        amount: savings.amount,
        reference: ref,
        userId: savings.userId,
        relatedId: savings._id,
        relatedModel: "Savings",
        notes: "Verified savings deposit",
        session,
      });
    });
  } finally {
    await session.endSession();
  }

  if (!savings) {
    return { alreadyVerified: true };
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
      reference: lookupRef,
      transactionId: String(data.id),
    },
  });

  return { alreadyVerified: false, savings };
};

const handleDepositWebhook = async (data) => {
  const reference = data.tx_ref || data.reference;
  const transactionId = data.id;
  const status = String(data.status || "").toLowerCase();
  const grossAmount = Number(data.charged_amount ?? data.amount ?? 0);
  const settledAmount = Number(data.amount_settled ?? data.amount ?? 0);

  if (!transactionId || !reference) return;
  if (status !== "successful") {
    // Only successful charges complete deposits; failures handled via verify path UX.
    return;
  }
  // Flutterwave best practice: re-verify with the API before fulfilling.
  let verified = null;
  try {
    verified = await verifyTransactionById(transactionId);
  } catch (e) {
    return;
  }
  const v = verified.data || {};
  if (String(v.status || "").toLowerCase() !== "successful") return;
  if (String(v.tx_ref || "") !== String(reference)) return;
  if (String(v.currency || "NGN").toUpperCase() !== "NGN") return;

  if (await PaymentRepository.isTransactionProcessed(transactionId, "savings")) {
    return;
  }
  const finalSettled = Number(v.amount_settled ?? v.amount ?? settledAmount);

  const session = await mongoose.startSession();
  let savings;
  try {
    await session.withTransaction(async () => {
      savings = await PaymentRepository.findAndCompleteDeposit(reference, {
        status: "completed",
        flutterwaveRef: String(transactionId),
        transactionId: String(transactionId),
        amount: finalSettled || undefined,
      }, session);
      if (savings) {
        await FinancialLedgerService.recordEntry({
          entryType: "inflow",
          accountCategory: "member_savings",
          activityType: "savings_deposit",
          amount: finalSettled || savings.amount,
          reference,
          userId: savings.userId,
          relatedId: savings._id,
          relatedModel: "Savings",
          notes: "Webhook-verified savings deposit",
          session,
        });
      }
    });
  } finally {
    await session.endSession();
  }

  if (!savings) return;

  {
    const finalAmount = finalSettled || savings.amount;
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
      details: { grossAmount, settledAmount: finalAmount, method: "flutterwave", reference },
    });
  }
};

const handleWithdrawalWebhook = async (data) => {
  const reference = data.reference || data.tx_ref;
  const status = data.status;
  const transferId = data.id;
  const settledAmount = data.amount;

  if (await PaymentRepository.isTransactionProcessed(transferId, "savings")) return;

  const session = await mongoose.startSession();
  let withdrawal;
  try {
    await session.withTransaction(async () => {
      withdrawal = await PaymentRepository.findWithdrawalByReference(reference, session);
      if (!withdrawal) return;

      if (withdrawal.flutterwaveRef && withdrawal.flutterwaveRef !== String(transferId)) return;

      if (status === "successful" || status === "success") {
        withdrawal = await PaymentRepository.markCompleted("savings", withdrawal._id, transferId, { amount: settledAmount }, session);
        if (!withdrawal) return;
    await FinancialLedgerService.recordEntry({
      entryType: "outflow",
      accountCategory: "cash_asset",
      activityType: "withdrawal_payout",
      amount: settledAmount,
      reference,
      userId: withdrawal.userId,
      relatedId: withdrawal._id,
      relatedModel: "Savings",
      notes: "Successful withdrawal payout",
          session,
    });
    if (withdrawal.fee > 0) {
      await FinancialLedgerService.recordEntry({
        entryType: "inflow",
        accountCategory: "withdrawal_fee_revenue",
        activityType: "withdrawal_fee",
        amount: withdrawal.fee,
        reference: `${reference}:fee`,
        userId: withdrawal.userId,
        relatedId: withdrawal._id,
        relatedModel: "Savings",
        notes: "Withdrawal processing fee",
          session,
      });
    }
      } else {
        withdrawal.status = "failed";
        await withdrawal.save({ session });
      }
    });
  } finally {
    await session.endSession();
  }

  if (!withdrawal) return;

  if (status === "successful" || status === "success") {
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
      details: { amount: settledAmount, method: "flutterwave_payout", reference },
    });
  } else {
    await createNotification({
      userId: withdrawal.userId,
      type: "savings",
      title: "Withdrawal Failed",
      message: `Your withdrawal of ₦${settledAmount.toLocaleString()} failed. Please try again or contact support.`,
    });
  }
};

const handleLoanPayoutWebhook = async (data) => {
  const reference = data.reference || data.tx_ref;
  const status = data.status;
  const transferId = data.id;
  const settledAmount = data.amount;

  if (await PaymentRepository.isTransactionProcessed(transferId, "loan", "payoutRef")) return;

  const loan = await PaymentRepository.findLoanByPayoutReference(reference);
  if (!loan) return;

  if (loan.payoutRef && loan.payoutRef !== String(transferId)) return;

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
};

const handleRepaymentWebhook = async (data) => {
  const reference = data.tx_ref || data.reference;
  const status = String(data.status || "").toLowerCase();
  const transactionId = data.id;
  const settledAmount = Number(data.amount_settled ?? data.charged_amount ?? data.amount ?? 0);

  if (!transactionId || !reference) return;
  if (status !== "successful") return;
  // Re-verify before crediting a loan (FLW best practice).
  try {
    const verified = await verifyTransactionById(transactionId);
    const v = verified.data || {};
    if (String(v.status || "").toLowerCase() !== "successful") return;
    if (String(v.tx_ref || "") !== String(reference)) return;
  } catch (e) {
    return;
  }

  if (await PaymentRepository.isTransactionProcessed(transactionId, "savings")) return;

  const repayment = await PaymentRepository.findRepaymentByReference(reference);
  if (!repayment) return;

  if (repayment.flutterwaveRef && repayment.flutterwaveRef !== String(transactionId)) return;

  if (status === "successful") {
    await processLoanRepayment({
      loanId: repayment.loanId,
      transactionId: String(transactionId),
      paymentAmount: settledAmount || repayment.amount,
      paymentReference: reference,
      paymentMethod: "flutterwave",
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
};

const handleMembershipFeeWebhook = async (data) => {
  const reference = data.tx_ref || data.reference;
  const transactionId = data.id;
  const status = String(data.status || "").toLowerCase();
  const amount = Number(data.charged_amount ?? data.amount_settled ?? data.amount ?? 0);

  if (status !== "successful") return;
  if (!reference || !transactionId) return;
  try {
    const verified = await verifyTransactionById(transactionId);
    const v = verified.data || {};
    if (String(v.status || "").toLowerCase() !== "successful") return;
    if (String(v.tx_ref || "") !== String(reference)) return;
    if (Number(v.charged_amount ?? v.amount ?? 0) < MEMBERSHIP_FEE_AMOUNT) return;
  } catch (e) {
    return;
  }
  if (amount < MEMBERSHIP_FEE_AMOUNT) return;

  const user = await PaymentRepository.findUserByMembershipRef(reference);
  if (!user || user.membershipFeePaid) return;

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
    details: { reference, transactionId, amount },
  });
};

const handleMinuteWebhook = async (data) => {
  const reference = data.tx_ref || data.reference;
  const transactionId = data.id;
  const status = String(data.status || "").toLowerCase();
  const amount = Number(data.charged_amount ?? data.amount_settled ?? data.amount ?? 0);

  if (!reference || !transactionId) return;

  // The checkout reference (MIN_...) lives on a pending Savings record
  // created by initializeMinutes. Find it first.
  const pendingPayment = await PaymentRepository.findSavingsByReference(reference);
  if (!pendingPayment) return;

  if (status !== "successful") {
    if (pendingPayment.status === "completed") return;
    pendingPayment.status = "failed";
    await pendingPayment.save();
    await createNotification({
      userId: pendingPayment.userId,
      type: "savings",
      title: "Monthly Contribution Failed",
      message: "Your SocketMinutes contribution could not be completed. Please try again.",
    });
    return;
  }

  // Re-verify before fulfilling minutes obligations.
  try {
    const verified = await verifyTransactionById(transactionId);
    const v = verified.data || {};
    if (String(v.status || "").toLowerCase() !== "successful") return;
    if (String(v.tx_ref || "") !== String(reference)) return;
  } catch (e) {
    return;
  }

  if (pendingPayment.status === "completed") return;

  // Settle ALL outstanding monthly obligations for this user.
  const userId = pendingPayment.userId;
  const mongoose = require("mongoose");
  const Minutes = require("../Models/MinutesModel");
  const session = await mongoose.startSession();
  let settledCount = 0;
  try {
    await session.withTransaction(async () => {
      const result = await Minutes.updateMany(
        {
          userId,
          status: { $in: ["pending", "overdue"] },
          category: "monthly_contribution",
        },
        {
          $set: {
            status: "completed",
            transactionId: String(transactionId),
            paidAt: new Date(),
          },
        },
        { session }
      );
      settledCount = result.modifiedCount || 0;

      pendingPayment.status = "completed";
      pendingPayment.transactionId = String(transactionId);
      await pendingPayment.save({ session });
    });
  } finally {
    await session.endSession();
  }

  if (settledCount === 0) return;

  await PaymentRepository.updateUser(userId, { thisMonthMinutesUnpaid: false });

  await createNotification({
    userId,
    type: "savings",
    title: "Monthly Contribution Successful",
    message: `Your SocketMinutes contribution for ${settledCount} month${settledCount > 1 ? "s" : ""} was successful.`,
  });

  await logAudit({
    userId,
    action: "monthly_minutes_paid",
    targetType: "minutes",
    targetId: pendingPayment._id,
    details: {
      amount,
      reference,
      transactionId,
      monthsSettled: settledCount,
      method: "flutterwave",
    },
  });
};

const processWebhook = async (rawBody, signature, event) => {
  const secretHash = process.env.FLW_SECRET_HASH || process.env.FLW_WEBHOOK_SECRET || "";
  if (!secretHash) {
    throw new AppError("Webhook secret hash is not configured.", 500);
  }
  const provided = String(signature || "");
  if (!provided) {
    throw new AppError("Webhook: missing signature header", 401);
  }
  const expectedBuf = Buffer.from(String(secretHash), "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  const signatureValid =
    providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  if (!signatureValid) {
    throw new AppError("Invalid webhook signature", 401);
  }

  const body = event || {};
  const eventName = String(body.event || "").toLowerCase();
  const payload = body.data || body || {};
  const transactionId = payload.id;
  const txRef = payload.tx_ref || payload.txRef || payload.reference || null;

  // Flutterwave collection events: charge.completed, charge.confirmed (+ transfer events for payouts).
  const isChargeEvent =
    eventName === "charge.completed" ||
    eventName === "charge.confirmed" ||
    eventName === "charge.successful" ||
    (!eventName && transactionId && txRef);
  const isTransferEvent =
    eventName === "transfer.completed" ||
    eventName === "transfer.failed" ||
    eventName === "transfer.reversed";

  if (!isChargeEvent && !isTransferEvent) return { status: "ignored" };
  if (!txRef) return { status: "ignored" };
  const reference = String(txRef);

  const normalizedData = {
    ...payload,
    id: transactionId,
    tx_ref: reference,
    reference,
    status: String(payload.status || (isChargeEvent ? "successful" : "") || "").toLowerCase(),
    charged_amount: Number(payload.charged_amount ?? payload.amount ?? 0),
    amount: Number(payload.amount ?? 0),
    amount_settled: Number(payload.amount_settled ?? payload.amount ?? 0),
    currency: payload.currency || "NGN",
  };

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
  } else if (reference.startsWith("MIN_")) {
    await handleMinuteWebhook(normalizedData);
  }

  return { status: "success" };
};

/**
 * FALLBACK 1+2 shared entrypoint: reconcile a payment by its tx_ref.
 *
 * Server-side only. Looks the reference up with Flutterwave, validates
 * status/amount/currency/reference, then routes it through the SAME
 * idempotent handlers the webhook uses — so a missing, delayed or rejected
 * webhook eventually resolves to the identical outcome without double credit.
 */
const reconcilePaymentByReference = async (reference) => {
  const ref = String(reference || "").trim();
  if (!ref) throw new AppError("Payment reference is required.", 400);

  const verification = await verifyPayment(ref);
  const data = verification?.data || null;

  if (!verification || verification.status !== "success" || !data) {
    return { status: "unverified", reference: ref };
  }

  const flwStatus = String(data.status || "").toLowerCase();
  if (flwStatus !== "successful") {
    return { status: flwStatus || "unknown", reference: ref };
  }

  const normalizedData = {
    ...data,
    id: data.id,
    tx_ref: String(data.tx_ref || data.reference || ref),
    reference: String(data.tx_ref || data.reference || ref),
    status: flwStatus,
    charged_amount: Number(data.charged_amount ?? data.amount ?? 0),
    amount: Number(data.amount ?? 0),
    amount_settled: Number(data.amount_settled ?? data.amount ?? 0),
    currency: data.currency || "NGN",
  };

  const targetRef = normalizedData.tx_ref;
  if (targetRef.startsWith("DEP_")) {
    await handleDepositWebhook(normalizedData);
  } else if (targetRef.startsWith("LRP_") || targetRef.startsWith("RPL_")) {
    await handleRepaymentWebhook(normalizedData);
  } else if (targetRef.startsWith("MEM_")) {
    await handleMembershipFeeWebhook(normalizedData);
  } else if (targetRef.startsWith("MIN_")) {
    await handleMinuteWebhook(normalizedData);
  } else {
    return { status: "ignored", reference: ref };
  }

  return { status: "reconciled", reference: ref };
};


const verifyBankAccount = async (accountNumber, bankCode) => {
  if (!accountNumber || !bankCode) throw new AppError("Account number and bank code are required.", 400);
  const result = await verifyAccount(accountNumber, bankCode);
  return {
    accountNumber: result.data.account_number,
    accountName: result.data.account_name,
    bankCode: result.data.bank_code,
  };
};

const PaymentService = {
  initiateDeposit,
  verifyDeposit,
  processWebhook,
  reconcilePaymentByReference,
  verifyBankAccount,
  getBanks: async () => (await getBanks()).data,
};

module.exports = { PaymentService };