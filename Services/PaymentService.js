const crypto = require("crypto");
const { startSafeSession } = require("../Utilis/transactionRunner");
const { PaymentRepository } = require("../Repositories/PaymentRepository");
const { FLW_PUBLIC_KEY, FLW_SUBACCOUNT_ID, verifyPayment, verifyTransactionById, verifyAccount, getBanks } = require("../Utilis/Flutterwave");
const { processLoanRepayment } = require("../Services/LoanService");
const { createNotification } = require("../Utilis/notificationHelper");
const { updateUserScore } = require("../Utilis/scoreService");
const { logAudit } = require("../Utilis/auditLogger");
const { FinancialLedgerService } = require("./FinancialLedgerService");
const { ReferralService } = require("./ReferralService");
const {
  recordSavingsTransaction,
  recordMinuteTransaction,
  recordMembershipTransaction,
  recordLoanTransaction,
} = require("./TransactionService");
const AppError = require("../Utilis/AppError");
const { MEMBERSHIP_FEE_AMOUNT } = require("../Config/constants");
const {
  toCanonicalStatus,
  typeFromReference,
  isReconcilableReference,
  isSuccessfulStatus,
} = require("../Utilis/paymentStatus");

const Savings = require("../Models/SavingsModel");
const LoanTransaction = require("../Models/LoanTransactionModel");
const MinuteTransaction = require("../Models/MinuteTransactionModel");
const MembershipTransaction = require("../Models/MembershipTransactionModel");
const SavingsTransaction = require("../Models/SavingsTransactionModel");
const User = require("../Models/UserModel");
const { sendPaymentReceiptSafe } = require("./ReceiptService");

const TERMINAL_FAILURE_STATUSES = ["failed", "cancelled", "canceled", "error", "declined", "abandoned", "reversed", "terminated"];

const initiateDeposit = async (userId, amount, method) => {
  const user = await PaymentRepository.findUser(userId);
  if (!user) throw new AppError("User not found", 404);

  // Reference shape (restored): `DEP_<ts>_<hex>_<userId[-6]>` — underscore
  // format REQUIRED because the webhook dispatcher (processWebhook) routes
  // by `reference.startsWith("DEP_")`, and the reconciliation sweep filters
  // `/^DEP_/`. Hyphen refs (fix 2) never reached their handler.
  const reference = `DEP_${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${userId
    .toString()
    .slice(-6)}`;
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
    // Same working-project customer shape as the Minutes flow (fix 1):
    // only documented keys, never an empty phone (Flutterwave telemetry
    // 400s on empty customer fields).
    customer: { email: user.email, name: user.fullName, phone_number: user.phone || "08000000000" },
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
  if (!isSuccessfulStatus(status)) {
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
  // Defensive: a SocketMinutes checkout is authorised against the minutes
  // settlement path only. It must never be completed as a savings deposit.
  if (String(existingSavings.category || "").toLowerCase() === "minutes_payment" || /^MIN_/i.test(lookupRef)) {
    throw new AppError("This reference is a Socket Minutes payment. Complete it via the minutes flow.", 400);
  }
  // Ownership comes BEFORE the completed-state fast path so a caller can never
  // probe another member's transaction reference (403 vs 404/already-settled).
  if (String(existingSavings.userId) !== String(userId)) {
    throw new AppError("This transaction does not belong to your account.", 403);
  }
  if (existingSavings.status === "completed") {
    // Replay of an already-settled deposit: re-run the idempotent referral
    // qualification so a transient failure from the first pass self-heals.
    await ReferralService.processQualification(existingSavings.userId, "first_deposit");
    return { alreadyVerified: true };
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

  const session = await startSafeSession();
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

  // Dual-write: dedicated savings transaction record (idempotent by reference).
  await recordSavingsTransaction({
    userId: savings.userId,
    type: savings.type === "withdrawal" ? "withdrawal" : "deposit",
    reference: savings.reference || lookupRef,
    transactionId: String(data.id),
    amount: savings.amount,
    fee: savings.fee || 0,
    currency: "NGN",
    status: "completed",
    method: savings.method || "flutterwave",
    paidAt: new Date(),
    metadata: { savingsId: String(savings._id), source: "verifyDeposit" },
  });

  // Receipt: exactly-once email for the settled deposit (idempotent claim).
  await sendPaymentReceiptSafe({
    userId: savings.userId,
    Model: SavingsTransaction,
    type: savings.type === "withdrawal" ? "withdrawal" : "deposit",
    reference: savings.reference || lookupRef,
    transactionId: String(data.id),
    amount: savings.amount,
    currency: "NGN",
    paidAt: new Date(),
  });

  await updateUserScore(savings.userId, "deposit");

  // Workflow K: may qualify a pending referral (idempotent).
  await ReferralService.processQualification(savings.userId, "first_deposit");

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

/**
 * Server-side callback reconciliation (P0-001).
 * Called from the Flutterwave redirect handler so a missed/delayed webhook
 * still gets the deposit settled idempotently. Bound to the deposit record's
 * own owner (the reference was generated server-side at initiation), so no
 * unauthenticated ownership bypass is possible.
 */
const reconcileDepositByReference = async (ref, transactionId) => {
  const lookupRef = String(ref || "").trim();
  if (!lookupRef) return { state: "missing_reference" };

  let pending = null;
  try {
    pending = await PaymentRepository.findSavingsByReference(lookupRef);
  } catch (e) {
    console.error("Callback reconciliation lookup failed:", e?.message || e);
    return { state: "pending" };
  }
  if (!pending) return { state: "not_found" };
  if (pending.status === "completed") return { state: "already_verified" };

  try {
    const result = await verifyDeposit(pending.userId, lookupRef, transactionId || null);
    return { state: result.alreadyVerified ? "already_verified" : "completed" };
  } catch (err) {
    const message = String(err?.message || "");
    if (err?.statusCode === 400 && /not successful/i.test(message)) {
      return { state: "failed", reason: "payment_not_successful" };
    }
    if (err?.statusCode === 400 && /amount mismatch/i.test(message)) {
      return { state: "failed", reason: "amount_mismatch" };
    }
    if (err?.statusCode === 400 && /reference mismatch/i.test(message)) {
      return { state: "failed", reason: "reference_mismatch" };
    }
    if (err?.statusCode === 400 && /currency/i.test(message)) {
      return { state: "failed", reason: "currency_mismatch" };
    }
    // Provider lag / timeout / unexpected error: do NOT mark success or failure.
    // Leave the deposit pending for the webhook or fallback reconciliation.
    console.error("Callback reconciliation deferred:", message);
    return { state: "pending" };
  }
};

const handleDepositWebhook = async (data) => {
  const reference = data.tx_ref || data.reference;
  const transactionId = data.id;
  const status = String(data.status || "").toLowerCase();
  const grossAmount = Number(data.charged_amount ?? data.amount ?? 0);
  const settledAmount = Number(data.amount_settled ?? data.amount ?? 0);

  console.log(
    `[DEPOSIT WEBHOOK] ① received | ref: ${reference} | TX: ${transactionId} | status: ${status} | gross: ${grossAmount} | settled: ${settledAmount}`
  );

  if (!transactionId || !reference) {
    console.log("[DEPOSIT WEBHOOK] ✗ missing reference or transaction id — ignoring event");
    return;
  }
  if (!isSuccessfulStatus(status)) {
    if (TERMINAL_FAILURE_STATUSES.includes(status)) {
      await Savings.updateOne(
        { reference, status: "pending", type: "deposit", category: { $ne: "minutes_payment" } },
        { $set: { status: "failed" } }
      ).catch((err) =>
        console.error(`[DEPOSIT WEBHOOK] failed to persist terminal failure: ${err?.message || err}`)
      );
    }
    console.log(`[DEPOSIT WEBHOOK] ✗ non-successful status "${status}" — no settlement`);
    return;
  }
  // Flutterwave best practice: re-verify with the API before fulfilling.
  let verified = null;
  try {
    verified = await verifyTransactionById(transactionId);
  } catch (e) {
    console.log(`[DEPOSIT WEBHOOK] ✗ FLW re-verify threw: ${e?.message || e} — no settlement`);
    return;
  }
  const v = verified.data || {};
  if (!isSuccessfulStatus(v.status)) {
    console.log(`[DEPOSIT WEBHOOK] ✗ FLW re-verify says status "${v.status}" — no settlement`);
    return;
  }
  if (String(v.tx_ref || "") !== String(reference)) {
    console.log(`[DEPOSIT WEBHOOK] ✗ tx_ref mismatch | expected: ${reference} | got: ${v.tx_ref} — no settlement`);
    return;
  }
  if (String(v.currency || "NGN").toUpperCase() !== "NGN") {
    console.log(`[DEPOSIT WEBHOOK] ✗ currency mismatch: ${v.currency} — no settlement`);
    return;
  }

  // Amount is checked against the server-created deposit intent. Never credit
  // from a webhook payload amount alone.
  const pendingRecord = await PaymentRepository.findSavingsByReference(reference);
  if (!pendingRecord) {
    console.log(`[DEPOSIT WEBHOOK] ✗ no savings deposit intent found for ref ${reference}`);
    return;
  }
  const verifiedGross = Number(v.charged_amount ?? v.amount ?? 0);
  if (!verifiedGross || verifiedGross < Number(pendingRecord.amount || 0)) {
    console.log(
      `[DEPOSIT WEBHOOK] ✗ amount mismatch | expected: ${pendingRecord.amount} | received: ${verifiedGross} — no settlement`
    );
    return;
  }
  console.log(`[DEPOSIT WEBHOOK] ② FLW re-verify OK | ref match | NGN | amount verified`);

  if (await PaymentRepository.isTransactionProcessed(transactionId, "savings")) {
    console.log(`[DEPOSIT WEBHOOK] ✗ transaction ${transactionId} already processed — idempotent skip`);
    return;
  }
  const finalSettled = Number(v.amount_settled ?? v.amount ?? settledAmount);

  const session = await startSafeSession();
  let savings;
  try {
    await session.withTransaction(async () => {
      console.log(`[DEPOSIT WEBHOOK] ③ completing deposit record for ref ${reference} | settled: ${finalSettled}`);
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

  if (!savings) {
    console.log(`[DEPOSIT WEBHOOK] ✗ finished — no matching pending deposit record for ref ${reference}`);
    return;
  }

  {
    const finalAmount = finalSettled || savings.amount;
    console.log(
      `[DEPOSIT WEBHOOK] ④ DB updated | deposit ${savings._id} completed for user ${savings.userId} | amount: ${finalAmount}`
    );

    // Dual-write: dedicated savings transaction record (idempotent by reference).
    await recordSavingsTransaction({
      userId: savings.userId,
      type: savings.type === "withdrawal" ? "withdrawal" : "deposit",
      reference: savings.reference || reference,
      transactionId: String(transactionId),
      amount: finalAmount,
      fee: savings.fee || 0,
      currency: "NGN",
      status: "completed",
      method: savings.method || "flutterwave",
      paidAt: new Date(),
      metadata: { savingsId: String(savings._id), source: "depositWebhook" },
    });

    // Receipt: exactly-once email for the settled deposit (idempotent claim).
    await sendPaymentReceiptSafe({
      userId: savings.userId,
      Model: SavingsTransaction,
      type: savings.type === "withdrawal" ? "withdrawal" : "deposit",
      reference: savings.reference || reference,
      transactionId: String(transactionId),
      amount: finalAmount,
      currency: "NGN",
      paidAt: new Date(),
    });

    await updateUserScore(savings.userId, "deposit");
    // Workflow K: may qualify a pending referral (idempotent). A failure here
    // must not fail the already-settled deposit and cannot be recovered by a
    // webhook replay, so it is logged loudly instead of thrown.
    try {
      await ReferralService.processQualification(savings.userId, "first_deposit");
    } catch (referralErr) {
      console.error(
        `Referral qualification failed for deposit ${reference} (recovery: member re-verify or support):`,
        referralErr?.message || referralErr
      );
    }
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
    console.log(
      `[DEPOSIT WEBHOOK] ✔ finished OK | ref: ${reference} | TX: ${transactionId} | amount: ${finalAmount} | user notified + audit logged`
    );
  }
};

const handleWithdrawalWebhook = async (data) => {
  const reference = data.reference || data.tx_ref;
  const status = data.status;
  const transferId = data.id;
  const settledAmount = data.amount;

  if (await PaymentRepository.isTransactionProcessed(transferId, "savings")) return;

  const session = await startSafeSession();
  let withdrawal;
  let didProcess = false;
  try {
    await session.withTransaction(async () => {
      withdrawal = await PaymentRepository.findWithdrawalByReference(reference, session);
      if (!withdrawal) return;

      // Never let a late/retried event reverse or repeat a settled withdrawal.
      if (withdrawal.status === "completed" || withdrawal.status === "failed") return;

      if (withdrawal.flutterwaveRef && withdrawal.flutterwaveRef !== String(transferId)) return;

      if (isSuccessfulStatus(status)) {
        withdrawal = await PaymentRepository.markCompleted("savings", withdrawal._id, transferId, { amount: settledAmount }, session);
        if (!withdrawal) return;
        didProcess = true;
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
      } else if (status === "failed" || status === "reversed") {
        // Confirmed payout failure (not a mere delayed webhook): the
        // reservation is released implicitly once the record is no longer
        // pending_approval/approved — reversing it here would double-credit.
        withdrawal.status = "failed";
        withdrawal.payoutFailedAt = new Date();
        await withdrawal.save({ session });
        didProcess = true;
      } else {
        // Timeout/pending/unknown → wait for reconciliation; no state change.
        return;
      }
    });
  } finally {
    await session.endSession();
  }

  // Notify only when this event actually changed the withdrawal state —
  // duplicate/replayed events are acknowledged silently.
  if (!withdrawal || !didProcess) return;

  if (isSuccessfulStatus(status)) {
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
      message: `Your withdrawal of ₦${Number(settledAmount || withdrawal.amount).toLocaleString()} failed. Please try again or contact support.`,
    });
  }
};

const handleLoanPayoutWebhook = async (data) => {
  const reference = data.reference || data.tx_ref;
  const status = data.status;
  const transferId = data.id;

  if (!reference || !transferId) return;
  if (await PaymentRepository.isTransactionProcessed(transferId, "loan", "payoutRef")) return;

  const loan = await PaymentRepository.findLoanByPayoutReference(reference);
  if (!loan) return;

  if (loan.payoutRef && loan.payoutRef !== String(transferId)) return;

  // Manual disbursement mode: do not auto-finalize loans from external transfer webhooks.
  // Record provider transfer outcome for audit/visibility only; admin-confirmed manual
  // disbursement remains the authoritative activation path.
  if (isSuccessfulStatus(status)) {
    if (loan.payoutStatus !== "completed" && loan.status !== "active") {
      loan.payoutProviderResponse = {
        ...(loan.payoutProviderResponse || {}),
        webhookStatus: status,
        webhookTransferId: String(transferId),
        webhookReference: reference,
        receivedAt: new Date(),
      };
      await loan.save();
    }
  } else if (String(status || "").toLowerCase() === "failed") {
    if (loan.payoutStatus !== "completed" && loan.status !== "active") {
      loan.payoutStatus = "failed";
      loan.payoutRef = String(transferId);
      loan.payoutFailedAt = new Date();
      loan.payoutFailureReason = data?.complete_message || data?.message || "Transfer failed";
      loan.payoutProviderResponse = {
        ...(loan.payoutProviderResponse || {}),
        webhookStatus: status,
        webhookTransferId: String(transferId),
        webhookReference: reference,
        receivedAt: new Date(),
      };
      await loan.save();
    }
  }
};

const handleRepaymentWebhook = async (data) => {
  const reference = data.tx_ref || data.reference;
  const status = String(data.status || "").toLowerCase();
  const transactionId = data.id;
  const settledAmount = Number(data.amount_settled ?? data.charged_amount ?? data.amount ?? 0);

  console.log(
    `[REPAYMENT WEBHOOK] ① received | ref: ${reference} | TX: ${transactionId} | status: ${status} | settled: ${settledAmount}`
  );

  if (!transactionId || !reference) {
    console.log("[REPAYMENT WEBHOOK] ✗ missing reference or transaction id — ignoring event");
    return;
  }
  const isTerminalFailureStatus = ["failed", "cancelled", "canceled", "error", "declined", "abandoned"].includes(status);

  if (!isSuccessfulStatus(status)) {
    if (!isTerminalFailureStatus) {
      console.log(`[REPAYMENT WEBHOOK] ✗ non-successful/non-terminal status "${status}" — ignoring event`);
      return;
    }
    // Persist terminal failure for pending repayments without attempting settlement.
    const repayment = await PaymentRepository.findRepaymentByReference(reference);
    if (!repayment) {
      console.log(`[REPAYMENT WEBHOOK] ✗ no matching repayment record for failed ref ${reference}`);
      return;
    }
    if (repayment.status === "successful") {
      console.log(`[REPAYMENT WEBHOOK] ✗ repayment already successful for failed ref ${reference} — ignoring`);
      return;
    }
    if (repayment.status !== "failed") {
      repayment.status = "failed";
      await repayment.save();
      await createNotification({
        userId: repayment.userId,
        type: "loan",
        title: "Loan Repayment Failed",
        message: `Your loan repayment of ₦${(settledAmount || repayment.amount).toLocaleString()} failed. Please try again.`,
      });
    }
    console.log(`[REPAYMENT WEBHOOK] ✔ finished (failed) | ref: ${reference} | repayment marked failed`);
    return;
  }

  // Re-verify before crediting a loan (FLW best practice).
  let verifiedPayment = null;
  try {
    const verified = await verifyTransactionById(transactionId);
    const v = verified.data || {};
    if (!isSuccessfulStatus(v.status)) {
      console.log(`[REPAYMENT WEBHOOK] ✗ FLW re-verify says status "${v.status}" — no settlement`);
      return;
    }
    if (String(v.tx_ref || "") !== String(reference)) {
      console.log(`[REPAYMENT WEBHOOK] ✗ tx_ref mismatch | expected: ${reference} | got: ${v.tx_ref} — no settlement`);
      return;
    }
    if (String(v.currency || "NGN").toUpperCase() !== "NGN") {
      console.log(`[REPAYMENT WEBHOOK] ✗ currency mismatch: ${v.currency} — no settlement`);
      return;
    }
    verifiedPayment = v;
    console.log("[REPAYMENT WEBHOOK] ② FLW re-verify OK | ref match | NGN");
  } catch (e) {
    console.log(`[REPAYMENT WEBHOOK] ✗ FLW re-verify threw: ${e?.message || e} — no settlement`);
    return;
  }

  if (await PaymentRepository.isTransactionProcessed(transactionId, "loan")) {
    console.log(`[REPAYMENT WEBHOOK] ✗ transaction ${transactionId} already processed — idempotent skip`);
    return;
  }

  const repayment = await PaymentRepository.findRepaymentByReference(reference);
  if (!repayment) {
    console.log(`[REPAYMENT WEBHOOK] ✗ no matching repayment record for ref ${reference}`);
    return;
  }

  // Amount is validated against the server-created intent, never the browser.
  const paidAmount = Number(verifiedPayment?.charged_amount ?? verifiedPayment?.amount ?? 0);
  if (!paidAmount || paidAmount < Number(repayment.amount || 0)) {
    console.log(
      `[REPAYMENT WEBHOOK] ✗ amount mismatch | expected: ${repayment.amount} | received: ${paidAmount} — no settlement`
    );
    return;
  }

  if (repayment.flutterwaveRef && repayment.flutterwaveRef !== String(transactionId)) {
    console.log(
      `[REPAYMENT WEBHOOK] ✗ repayment already tied to another TX (${repayment.flutterwaveRef}) — ignoring`
    );
    return;
  }

  console.log(
    `[REPAYMENT WEBHOOK] ③ updating loan ${repayment.loanId} | userId: ${repayment.userId} | amount: ${paidAmount}`
  );
  await processLoanRepayment({
    loanId: repayment.loanId,
    transactionId: String(transactionId),
    paymentAmount: paidAmount,
    paymentReference: reference,
    paymentMethod: "flutterwave",
    verifiedData: verifiedPayment,
  });

  await createNotification({
    userId: repayment.userId,
    type: "loan",
    title: "Loan Repayment Successful",
    message: `Your loan repayment of ₦${paidAmount.toLocaleString()} was successful.`,
  });
  await logAudit({
    userId: repayment.userId,
    action: "loan_repay",
    targetType: "loan",
    targetId: repayment.loanId,
    details: { amount: paidAmount, reference },
  });

  // Dedicated loan transaction record (idempotent by reference).
  await recordLoanTransaction({
    userId: repayment.userId,
    loanId: repayment.loanId,
    type: "loan_repayment",
    reference,
    transactionId: String(transactionId),
    amount: paidAmount,
    currency: "NGN",
    status: "completed",
    method: "flutterwave",
    paidAt: new Date(),
    metadata: { source: "repaymentWebhook", providerTransactionId: String(transactionId) },
  });

  // Receipt: exactly-once email for the settled repayment (idempotent claim).
  await sendPaymentReceiptSafe({
    userId: repayment.userId,
    Model: LoanTransaction,
    type: "loan_repayment",
    reference,
    transactionId: String(transactionId),
    amount: paidAmount,
    currency: "NGN",
    paidAt: new Date(),
  });

  console.log(
    `[REPAYMENT WEBHOOK] ✔ finished OK | ref: ${reference} | TX: ${transactionId} | amount: ${paidAmount} | user notified + audit logged`
  );
};

const handleMembershipFeeWebhook = async (data) => {
  const reference = data.tx_ref || data.reference;
  const transactionId = data.id;
  const status = String(data.status || "").toLowerCase();
  const amount = Number(data.charged_amount ?? data.amount_settled ?? data.amount ?? 0);

  console.log(
    `[MEMBERSHIP WEBHOOK] ① received | ref: ${reference} | TX: ${transactionId} | status: ${status} | amount: ${amount}`
  );

  if (!isSuccessfulStatus(status)) {
    if (TERMINAL_FAILURE_STATUSES.includes(status)) {
      await MembershipTransaction.updateOne(
        { reference, status: "pending" },
        { $set: { status: "failed", "metadata.failureStatus": status } }
      ).catch((err) =>
        console.error(`[MEMBERSHIP WEBHOOK] failed to persist terminal failure: ${err?.message || err}`)
      );
    }
    console.log(`[MEMBERSHIP WEBHOOK] ✗ non-successful status "${status}" — no settlement`);
    return;
  }
  if (!reference || !transactionId) {
    console.log("[MEMBERSHIP WEBHOOK] ✗ missing reference or transaction id — ignoring event");
    return;
  }
  try {
    const verified = await verifyTransactionById(transactionId);
    const v = verified.data || {};
    if (!isSuccessfulStatus(v.status)) {
      console.log(`[MEMBERSHIP WEBHOOK] ✗ FLW re-verify says status "${v.status}" — no settlement`);
      return;
    }
    if (String(v.tx_ref || "") !== String(reference)) {
      console.log(`[MEMBERSHIP WEBHOOK] ✗ tx_ref mismatch | expected: ${reference} | got: ${v.tx_ref} — no settlement`);
      return;
    }
    if (String(v.currency || "NGN").toUpperCase() !== "NGN") {
      console.log(`[MEMBERSHIP WEBHOOK] ✗ currency mismatch: ${v.currency} — no settlement`);
      return;
    }
    if (Number(v.charged_amount ?? v.amount ?? 0) < MEMBERSHIP_FEE_AMOUNT) {
      console.log(
        `[MEMBERSHIP WEBHOOK] ✗ verified amount ${v.charged_amount ?? v.amount} below fee ${MEMBERSHIP_FEE_AMOUNT} — no settlement`
      );
      return;
    }
    console.log(`[MEMBERSHIP WEBHOOK] ② FLW re-verify OK | ref match | amount ≥ fee`);
  } catch (e) {
    console.log(`[MEMBERSHIP WEBHOOK] ✗ FLW re-verify threw: ${e?.message || e} — no settlement`);
    return;
  }
  if (amount < MEMBERSHIP_FEE_AMOUNT) {
    console.log(`[MEMBERSHIP WEBHOOK] ✗ webhook amount ${amount} below fee ${MEMBERSHIP_FEE_AMOUNT} — no settlement`);
    return;
  }

  const user = await PaymentRepository.findUserByMembershipRef(reference);
  if (!user) {
    console.log(`[MEMBERSHIP WEBHOOK] ✗ no user found for membership ref ${reference}`);
    return;
  }
  if (user.membershipFeePaid) {
    console.log(`[MEMBERSHIP WEBHOOK] ✗ user ${user._id} already has membership paid — idempotent skip`);
    return;
  }

  // Atomic claim: two concurrent webhook deliveries may both read
  // membershipFeePaid=false, but only one can flip it to true. Keep the
  // original MEM_ reference so status polling never loses the checkout record.
  console.log(`[MEMBERSHIP WEBHOOK] ③ updating user ${user._id} | marking membershipFeePaid: true`);
  const updatedUser = await User.findOneAndUpdate(
    { _id: user._id, membershipFeePaid: { $ne: true } },
    {
      $set: {
        membershipFeePaid: true,
        membershipFeePaidAt: new Date(),
        membershipFeeTxRef: reference,
      },
    },
    { new: true }
  );
  if (!updatedUser) {
    console.log(`[MEMBERSHIP WEBHOOK] ✗ membership already activated by a concurrent event — idempotent skip`);
    return;
  }
  console.log(`[MEMBERSHIP WEBHOOK] ④ DB updated | user ${updatedUser._id} membership activated`);

  // Dedicated membership transaction record (idempotent by reference).
  await recordMembershipTransaction({
    userId: updatedUser._id,
    reference,
    transactionId: String(transactionId),
    amount: MEMBERSHIP_FEE_AMOUNT,
    currency: "NGN",
    status: "completed",
    method: "flutterwave",
    paidAt: updatedUser.membershipFeePaidAt || new Date(),
    metadata: { source: "membershipWebhook", providerTransactionId: String(transactionId) },
  });

  // Receipt: exactly-once email for the settled fee (idempotent claim).
  await sendPaymentReceiptSafe({
    userId: updatedUser._id,
    Model: MembershipTransaction,
    type: "membership_fee",
    reference,
    transactionId: String(transactionId),
    amount: MEMBERSHIP_FEE_AMOUNT,
    currency: "NGN",
    paidAt: updatedUser.membershipFeePaidAt || new Date(),
  });

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

  // Workflow K: a paid membership fee may qualify a pending referral
  // (idempotent). A failure cannot block the settled fee and cannot be
  // recovered by a webhook replay, so it is logged loudly instead of thrown.
  try {
    await ReferralService.processQualification(user._id, "membership_fee_paid");
  } catch (referralErr) {
    console.error(
      `Referral qualification failed for membership fee ${reference} (recovery: member re-verify endpoint):`,
      referralErr?.message || referralErr
    );
  }

  console.log(
    `[MEMBERSHIP WEBHOOK] ✔ finished OK | ref: ${reference} | TX: ${transactionId} | user ${user._id} activated + notified + audit logged`
  );

  // SocketScore: membership fee is a verified financial activity — recalc
  // (guarded so a scoring failure can never fail an already-settled webhook).
  try {
    await updateUserScore(user._id, "membership_fee_paid");
  } catch (scoreErr) {
    console.error(`Membership score update failed for user ${user._id}:`, scoreErr?.message || scoreErr);
  }
};

const handleMinuteWebhook = async (data) => {
  const reference = data.tx_ref || data.reference;
  const transactionId = data.id;
  const status = String(data.status || "").toLowerCase();
  const amount = Number(data.charged_amount ?? data.amount_settled ?? data.amount ?? 0);

  console.log(
    `[MINUTES WEBHOOK] ① received | ref: ${reference} | TX: ${transactionId} | status: ${status} | amount: ${amount}`
  );

  if (!reference || !transactionId) {
    console.log("[MINUTES WEBHOOK] ✗ missing reference or transaction id — ignoring event");
    return;
  }

  // The checkout reference lives on a pending MinuteTransaction record created
  // by initializeMinutes. It is never a Savings record. There is deliberately
  // NO fallback to client metadata/customer identity: only the server-created
  // intent may choose the member, category and amount.
  const pendingPayment = await PaymentRepository.findMinutesCheckoutByReference(reference);
  console.log(
    `[MINUTES WEBHOOK] ② checkout record ${pendingPayment ? `found (status: ${pendingPayment.status})` : "NOT found"}`
  );
  if (!pendingPayment) {
    console.error(
      `[MINUTES WEBHOOK] ✗ no server-created MinuteTransaction for ref ${reference} — refusing to settle`
    );
    return;
  }

  if (!isSuccessfulStatus(status)) {
    if (pendingPayment.status !== "pending") return;
    const failed = await MinuteTransaction.findOneAndUpdate(
      { _id: pendingPayment._id, status: "pending" },
      { $set: { status: "failed", "metadata.failureStatus": status } },
      { new: true }
    );
    if (!failed) return;
    console.log(`[MINUTES WEBHOOK] ③ checkout record FAILED (webhook status: ${status})`);
    await createNotification({
      userId: pendingPayment.userId,
      type: "savings",
      title: "Monthly Contribution Failed",
      message: "Your SocketMinutes contribution could not be completed. Please try again.",
    });
    console.log("[MINUTES WEBHOOK] ✔ failure flow finished (record failed + user notified)");
    return;
  }

  // Re-verify before fulfilling minutes obligations.
  let verifiedData = null;
  try {
    const verified = await verifyTransactionById(transactionId);
    const v = verified.data || {};
    if (!isSuccessfulStatus(v.status)) {
      console.log(
        `[MINUTES WEBHOOK] ✗ FLW re-verify says status "${v.status}" (not successful) — no settlement`
      );
      return;
    }
    if (String(v.tx_ref || "") !== String(reference)) {
      console.log(
        `[MINUTES WEBHOOK] ✗ FLW re-verify tx_ref mismatch | expected: ${reference} | got: ${v.tx_ref} — no settlement`
      );
      return;
    }
    if (String(v.currency || "NGN").toUpperCase() !== "NGN") {
      console.log(`[MINUTES WEBHOOK] ✗ currency mismatch: ${v.currency} — no settlement`);
      return;
    }
    console.log(`[MINUTES WEBHOOK] ④ FLW re-verify OK | ref match | settled amount: ${v.amount_settled ?? v.amount}`);
    verifiedData = v;
  } catch (e) {
    console.log(`[MINUTES WEBHOOK] ✗ FLW re-verify threw: ${e?.message || e} — no settlement`);
    return;
  }

  if (pendingPayment.status !== "pending") return;

  // Settle exactly what this checkout paid for — never every outstanding
  // obligation. The checkout priced the earliest arrears into ONE reference
  // (stored on the pending MinuteTransaction). Money, member and category all
  // come from that server-created intent; the provider payload only confirms
  // that the charge succeeded.
  const userId = String(pendingPayment.userId);
  const budget = Number(pendingPayment.amount || 0);
  const paid = Number(verifiedData.charged_amount ?? verifiedData.amount ?? 0);
  const Minutes = require("../Models/MinutesModel");
  const { calculateFlutterwaveFee } = require("../Utilis/flutterwaveFee");

  const session = await startSafeSession();
  let settledCount = 0;
  let settledCurrentMonth = false;
  let failureReason = null;
  try {
    await session.withTransaction(async () => {
      // Atomic claim: concurrent/replayed webhooks can only settle this
      // checkout once. The intent is marked terminal INSIDE the same DB
      // transaction as the monthly-obligation updates, so it can never be
      // "completed" with zero months settled.
      const claimed = await MinuteTransaction.findOneAndUpdate(
        { _id: pendingPayment._id, status: "pending" },
        {
          $set: {
            status: "completed",
            transactionId: String(transactionId),
            "metadata.providerTransactionId": String(transactionId),
          },
        },
        { new: true, session }
      );
      if (!claimed) return;

      const currentOutstanding = await Minutes.find({
        userId,
        status: { $in: ["pending", "overdue", "failed"] },
        category: "monthly_contribution",
      })
        .sort({ year: 1, month: 1 })
        .session(session);

      const failClaim = async (reason) => {
        // Roll the premature "completed" claim back to failed in this same
        // transaction. The webhook still produces an honest terminal state.
        failureReason = reason;
        await MinuteTransaction.updateOne(
          { _id: pendingPayment._id, status: "completed" },
          {
            $set: {
              status: "failed",
              "metadata.failureReason": reason,
              "metadata.providerTransactionId": String(transactionId),
            },
          },
          { session }
        );
      };

      if (!currentOutstanding.length) {
        await failClaim("no_outstanding_minutes");
        return;
      }

      // Underpayment: settle nothing. Compare gross charged amount with the
      // gross budget stored on the intent so fee-inclusive values are on the
      // same scale.
      if (!budget || paid + 0.01 < budget) {
        await failClaim("underpayment");
        return;
      }

      // Largest prefix of outstanding obligations (oldest first) whose
      // grossed-up price still fits the checkout budget.
      let settleCount = 0;
      let sum = 0;
      while (settleCount < currentOutstanding.length) {
        sum += Number(currentOutstanding[settleCount].amount || 0);
        const { totalPayable } = calculateFlutterwaveFee(sum);
        if (totalPayable > budget) break;
        settleCount += 1;
      }
      if (settleCount === 0) {
        await failClaim("budget_did_not_fit_any_obligation");
        return;
      }

      const toSettle = currentOutstanding.slice(0, settleCount);
      console.log(
        `[MINUTES WEBHOOK] ⑥ settling ${settleCount} month(s) | budget: ${budget} | paid: ${paid} | userId: ${userId}`
      );
      const result = await Minutes.updateMany(
        {
          _id: { $in: toSettle.map((item) => item._id) },
          status: { $in: ["pending", "failed", "overdue"] },
        },
        {
          $set: {
            status: "completed",
            transactionId: String(transactionId),
            flutterwaveRef: String(transactionId),
            paidAt: new Date(),
          },
        },
        { session }
      );
      settledCount = result.modifiedCount || 0;
      if (settledCount === 0) {
        // Another writer settled these obligations between read and update.
        // Do not leave the checkout marked completed with nothing applied.
        await failClaim("obligations_already_settled");
        return;
      }
      const now = new Date();
      settledCurrentMonth = toSettle.some(
        (item) =>
          item.month === now.getMonth() + 1 && item.year === now.getFullYear()
      );
      console.log(
        `[MINUTES WEBHOOK] ⑦ DB updated | months settled: ${settledCount} | current month included: ${settledCurrentMonth}`
      );
    });
  } finally {
    await session.endSession();
  }

  if (failureReason || settledCount === 0) {
    console.log(
      `[MINUTES WEBHOOK] ✗ no month settled | reason: ${failureReason || "unknown"} | checkout marked failed`
    );
    await createNotification({
      userId,
      type: "savings",
      title: "Monthly Contribution Failed",
      message: "Your SocketMinutes contribution could not be applied. Please review and try again.",
    });
    return;
  }

  // thisMonthMinutesUnpaid clears ONLY when the current month's obligation
  // was actually settled — not merely because some arrears were paid.
  if (settledCurrentMonth) {
    await PaymentRepository.updateUser(userId, { thisMonthMinutesUnpaid: false });
  }

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
    targetId: pendingPayment?._id || undefined,
    details: {
      amount: budget,
      reference,
      transactionId,
      monthsSettled: settledCount,
      method: "flutterwave",
      resolvedVia: "server-created-intent",
    },
  });

  console.log(
    `[MINUTES WEBHOOK] ✔ finished OK | ref: ${reference} | TX: ${transactionId} | months settled: ${settledCount} | user notified + audit logged`
  );

  // Dual-write: dedicated minute transaction record (idempotent by reference).
  await recordMinuteTransaction({
    userId,
    reference,
    transactionId: String(transactionId),
    amount: budget,
    currency: "NGN",
    status: "completed",
    method: "flutterwave",
    paidAt: new Date(),
    metadata: {
      source: "minuteWebhook",
      monthsSettled: settledCount,
      resolvedVia: "server-created-intent",
    },
  });

  // Receipt: exactly-once email for the settled contribution (idempotent claim).
  await sendPaymentReceiptSafe({
    userId,
    Model: MinuteTransaction,
    type: "minute_contribution",
    reference,
    transactionId: String(transactionId),
    amount: budget,
    currency: "NGN",
    paidAt: new Date(),
    monthsSettled: settledCount,
  });

  // SocketScore: minutes payment is verified financial activity — recalc
  // (guarded so a scoring failure can never fail an already-settled webhook).
  try {
    await updateUserScore(userId, "minutes_paid");
  } catch (scoreErr) {
    console.error(`Minutes score update failed for user ${userId}:`, scoreErr?.message || scoreErr);
  }
};

// Pure normalizer exposed for regression tests: provider payloads are mapped
// once, before any handler reads them. Browser/redirect data never enters this
// path.
const normalizeWebhookData = (payload = {}) => ({
  ...payload,
  status: String(payload.status || "").toLowerCase(),
  charged_amount: Number(payload.charged_amount ?? payload.amount ?? 0),
  amount: Number(payload.amount ?? 0),
  amount_settled: Number(payload.amount_settled ?? payload.amount ?? 0),
  currency: payload.currency || "NGN",
});

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
    // Alert on signature mismatches without logging the secret or body contents.
    console.error(
      `Webhook signature mismatch: header "${providedBuf.length} bytes" did not match the configured secret hash.`
    );
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

  const normalizedData = normalizeWebhookData({
    ...payload,
    id: transactionId,
    tx_ref: reference,
    reference,
    status: payload.status || (isChargeEvent ? "successful" : ""),
  });

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


/**
 * Mask an account number for logs: first 4 + last 4 visible so the real
 * input can be confirmed, full number never written to logs.
 */
const maskAccount = (num) => {
  const s = String(num || "");
  if (s.length <= 8) return `len=${s.length}`;
  return `${s.slice(0, 4)}****${s.slice(-4)} (len=${s.length})`;
};

const verifyBankAccount = async (accountNumber, bankCode) => {
  console.log(
    `[BANK] SERVICE entered | bankCode: ${bankCode ?? "undefined"} | accountNumber: ${accountNumber ? maskAccount(accountNumber) : "missing"}`
  );
  if (!accountNumber || !bankCode) throw new AppError("Account number and bank code are required.", 400);
  let result;
  try {
    result = await verifyAccount(accountNumber, bankCode);
  } catch (e) {
    const rawFlwMessage = e?.response?.data?.message || e?.message || "Bank verification failed";
    const flwBody = e?.response?.data
      ? JSON.stringify(e.response.data).slice(0, 600)
      : "none";
    console.log(
      `[BANK] SERVICE FAILED | bankCode: ${bankCode ?? "undefined"} | accountNumber: ${maskAccount(accountNumber)} | errName: ${e?.name} | errStatus: ${e?.response?.status || e?.statusCode || "—"} | errMsg: ${rawFlwMessage} | flwBody: ${flwBody}`
    );
    // FLW sandbox note: test keys only resolve TEST accounts. A real
    // account verified with TEST credentials returns "invalid account" —
    // that is an environment mismatch, not wrong input. Tell the user.
    const secret = process.env.FLW_SECRET_KEY || process.env.FLWSECK || process.env.Flw_SECRET_KEY || "";
    const isTestMode = /_TEST/i.test(secret);
    const isInvalidAccount = /invalid account/i.test(rawFlwMessage);
    const userMessage =
      isTestMode && isInvalidAccount
        ? `${rawFlwMessage}. Test mode: only test accounts resolve — use a test account number or switch to live Flutterwave keys.`
        : rawFlwMessage;
    // Any Flutterwave rejection here is an expected business outcome
    // (invalid bank code, invalid account, etc.) — surface it as a clean
    // 400 so the frontend can display the reason, never a 500.
    throw new AppError(userMessage, e?.response?.status && Number(e.response.status) < 500 ? Number(e.response.status) : 400);
  }
  console.log(
    `[BANK] SERVICE ok | bankCode: ${bankCode} | accountNumber: ${maskAccount(accountNumber)} | resolvedAccountName: ${result.data?.account_name || "—"}`
  );
  return {
    accountNumber: result.data.account_number,
    accountName: result.data.account_name,
    bankCode: result.data.bank_code,
  };
};

const getPaymentStatus = async (userId, reference) => {
  const ref = String(reference || "").trim();
  if (!ref) throw new AppError("Payment reference is required.", 400);

  const own = (doc) => doc && String(doc.userId) === String(userId);
  const receiptFrom = (doc, type) => ({
    found: true,
    reference: ref,
    type: type || typeFromReference(ref) || "payment",
    status: toCanonicalStatus(doc.status),
    amount: Number(doc.amount || 0),
    // Withdrawal receipts show the processing fee and the total deduction.
    fee: Number(doc.fee || 0),
    method: doc.method || "flutterwave",
    transactionId: doc.transactionId || null,
    paidAt: doc.paidAt || doc.createdAt || null,
    // The member's own payout destination (savings withdrawals only).
    destinationBank: doc.bankDetails
      ? {
          bankName: doc.bankDetails.bankName || null,
          accountName: doc.bankDetails.accountName || null,
          accountNumber: doc.bankDetails.accountNumber || null,
        }
      : null,
    monthsSettled:
      Array.isArray(doc.metadata?.months) && doc.metadata.months.length
        ? doc.metadata.months.length
        : Number(doc.metadata?.monthsCount) || null,
  });

  // Webhook-only confirmation: read the status established by the authoritative
  // webhook. This endpoint NEVER verifies with Flutterwave and NEVER settles a
  // payment — it is a read model for the result pages only.
  const [loanTx, minuteTx, membershipTx, savingsTx] = await Promise.all([
    LoanTransaction.findOne({ reference: ref, userId }).lean(),
    MinuteTransaction.findOne({ reference: ref, userId }).lean(),
    MembershipTransaction.findOne({ reference: ref, userId }).lean(),
    SavingsTransaction.findOne({ reference: ref, userId }).lean(),
  ]);

  const dedicated =
    (loanTx && receiptFrom(loanTx, "loan_repayment")) ||
    (minuteTx && receiptFrom(minuteTx, "minute_contribution")) ||
    (membershipTx && receiptFrom(membershipTx, "membership_fee")) ||
    (savingsTx && receiptFrom(savingsTx));
  // Any terminal state (successful OR failed) is authoritative. Pending stays
  // pending until the webhook writes a terminal state.
  if (dedicated && dedicated.status !== "pending") return dedicated;

  // Legacy operational state, scoped to the requesting user. New flows use
  // the dedicated transaction records above.
  const [savingsDoc, minutesDoc, memberDoc] = await Promise.all([
    PaymentRepository.findSavingsByReference(ref),
    PaymentRepository.findMinutesByReference(ref),
    PaymentRepository.findUserByMembershipRef(ref),
  ]);

  const ownsSavings = own(savingsDoc);
  const ownsMinutes = own(minutesDoc);
  const ownsMembership = memberDoc && String(memberDoc._id) === String(userId);

  if (!ownsSavings && !ownsMinutes && !ownsMembership && !dedicated) {
    // Not found anywhere for this user — never fabricated, never leaked.
    throw new AppError("Transaction not found for this account.", 404);
  }

  const current =
    (dedicated && dedicated.status === "pending" && dedicated) ||
    (ownsMinutes
      ? receiptFrom(minutesDoc, "minute_contribution")
      : ownsSavings
        ? receiptFrom(savingsDoc)
        : ownsMembership
        ? {
            found: true,
            reference: ref,
            type: "membership_fee",
            status: memberDoc.membershipFeePaid ? "successful" : "pending",
            amount: MEMBERSHIP_FEE_AMOUNT,
            fee: 0,
            method: "flutterwave",
            transactionId: null,
            paidAt: memberDoc.membershipFeePaidAt || null,
            destinationBank: null,
            monthsSettled: null,
          }
        : dedicated);

  return { ...current, lastCheckedAt: new Date().toISOString() };
};
const PaymentService = {
  initiateDeposit,
  verifyDeposit,
  processWebhook,
  reconcilePaymentByReference,
  reconcileDepositByReference,
  verifyBankAccount,
  getPaymentStatus,
  normalizeWebhookData,
  toCanonicalStatus,
  typeFromReference,
  isReconcilableReference,
  getBanks: async () => (await getBanks()).data,
};

/**
 * PaymentService settlement policy (webhook-only).
 *
 * The signed Flutterwave webhook is the sole confirmation path. The status
 * endpoint is a READ MODEL over the webhook-written records and never calls
 * Flutterwave, reconciles, or mutates financial state. Pending stays pending
 * until the webhook establishes a terminal state.
 *
 * Ownership is enforced: every lookup is scoped to the requesting user, and
 * cross-account references return 404 (never leak another member's payment).
 */

module.exports = { PaymentService };
