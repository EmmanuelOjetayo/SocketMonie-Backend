const { PaymentService } = require("../Services/PaymentService");
const { PaymentRepository } = require("../Repositories/PaymentRepository");

exports.initiateDeposit = async (req, res, next) => {
  try {
    const { amount, method } = req.body;
    const userId = req.user._id;
    const data = await PaymentService.initiateDeposit(userId, amount, method);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    next(err);
  }
};

exports.paymentCallback = async (req, res) => {
  try {
    // Flutterwave Standard redirect returns ?status=successful&tx_ref=...&transaction_id=...
    const { tx_ref, transaction_id, status, reference } = req.query;
    const ref = tx_ref || reference || null;
    const txId = transaction_id || null;

    if (!ref && !txId) {
      return res.redirect(`${process.env.FRONTEND_URL}/payments/savings/failed?reason=missing_reference`);
    }

    const params = [];
    if (ref) {
      params.push(`tx_ref=${encodeURIComponent(ref)}`);
      params.push(`reference=${encodeURIComponent(ref)}`);
    }
    if (txId) params.push(`transaction_id=${encodeURIComponent(txId)}`);
    if (status) params.push(`status=${encodeURIComponent(status)}`);



    // P0-001: settle the deposit server-side (idempotent) BEFORE redirecting,
    // so a missed/delayed webhook can't leave the payment unrecorded.
    // Outcome is judged by authoritative Flutterwave verification, never by
    // the callback query params.
    if (ref) {
      try {
        const reconcile = await PaymentService.reconcileDepositByReference(ref, txId);
        if (reconcile.state === "completed" || reconcile.state === "already_verified") {
          params.push(`verified=1`);
          // Server-verified success wins over any callback status param.
          return res.redirect(
            `${process.env.FRONTEND_URL}/payments/savings/success?${params.join("&")}`
          );
        }
        if (reconcile.state === "failed") {
          params.push(`reason=reconciliation_${reconcile.reason || "failed"}`);
          return res.redirect(
            `${process.env.FRONTEND_URL}/payments/savings/failed?${params.join("&")}`
          );
        }
        if (reconcile.state === "not_found") {
          params.push(`reason=reference_not_found`);
          return res.redirect(
            `${process.env.FRONTEND_URL}/payments/savings/failed?${params.join("&")}`
          );
        }
        // state === "pending": provider verification unavailable — redirect to the
        // success page, which re-verifies server-side on load and routes to
        // failed/pending as appropriate. Never claim success on the callback alone.
        if (reconcile.state === "pending") {
          return res.redirect(
            `${process.env.FRONTEND_URL}/payments/savings/success?${params.join("&")}`
          );
        }
      } catch (err) {
        // Any unexpected reconciliation failure keeps the normal redirect flow;
        // webhook + frontend re-verification remain the safety net.
        console.error("Callback reconciliation error:", err?.message || err);
      }
    }

    // No verifiable outcome was established server-side — never choose the
    // redirect target from the callback query params alone. The frontend status
    // poller remains the authoritative source once a reference exists.
    return res.redirect(`${process.env.FRONTEND_URL}/payments/savings/success?${params.join("&")}`);
  } catch (err) {
    console.error("Callback error:", err);
    return res.redirect(`${process.env.FRONTEND_URL}/payments/savings/failed?reason=callback_error`);
  }
};

exports.verifyDeposit = async (req, res, next) => {
  try {
    const { reference, tx_ref, transaction_id, transactionId } = req.body;
    const ref = tx_ref || reference || null;
    const txId = transaction_id || transactionId || (/^\d+$/.test(String(ref || "")) ? String(ref) : null);

    const result = await PaymentService.verifyDeposit(req.user._id, ref, txId);

    if (result.alreadyVerified) {
      // Re-read the settled record so a verification replay still returns the
      // authoritative receipt instead of a bare "already verified" flag.
      const settled = ref
        ? await PaymentRepository.findSavingsByReference(String(ref).trim())
        : null;
      if (settled && String(settled.userId) === String(req.user._id)) {
        return res.status(200).json({
          success: true,
          message: "Already verified",
          data: {
            reference: settled.reference,
            transactionId: settled.transactionId || null,
            amount: Number(settled.amount || 0),
            type: settled.type || "deposit",
            status: "successful",
            method: settled.method || "flutterwave",
            paidAt: settled.updatedAt || settled.createdAt || null,
          },
        });
      }
      return res.status(200).json({ success: true, message: "Already verified" });
    }

    return res.status(200).json({
      success: true,
      message: "Verified successfully",
      data: result.savings
        ? {
            reference: result.savings.reference || ref,
            transactionId: result.savings.transactionId || null,
            amount: Number(result.savings.amount || 0),
            type: result.savings.type || "deposit",
            status: "successful",
            method: result.savings.method || "flutterwave",
            paidAt: new Date().toISOString(),
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
};

exports.webhook = async (req, res) => {
  try {
    // Flutterwave signs webhooks with the `verif-hash` header (your FLW secret hash).
    const signature = req.headers["verif-hash"] || req.headers["verif_hash"];
    const result = await PaymentService.processWebhook(req.rawBody, signature, req.body);
    return res.status(200).json(result);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({ status: "error", message: err.message });
  }
};

/**
 * Authoritative transaction status for success pages (backend is the source
 * of truth). Returns the webhook/callback-confirmed outcome for a reference
 * so neither a browser redirect nor location.state is ever displayed as
 * proof of payment. While pending, triggers one idempotent provider
 * reconciliation pass (same handlers the webhook uses) so a missed webhook
 * settles server-side and the polling page converges on the real result.
 */
exports.getPaymentStatus = async (req, res, next) => {
  try {
    const { reference } = req.params;
    const data = await PaymentService.getPaymentStatus(req.user._id, reference);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
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

exports.verifyBankAccount = async (req, res, next) => {
  let bankCode;
  let accountNumber;
  try {
    const body = req.body || {};
    bankCode = body.bankCode;
    accountNumber = body.accountNumber;
    console.log(
      `[BANK] verify-bank request received | bankCode: ${bankCode || "—"} | accountNumber: ${accountNumber ? maskAccount(accountNumber) : "missing"} | rawBody: ${JSON.stringify({ accountNumber: maskAccount(accountNumber), bankCode })}`
    );
    const data = await PaymentService.verifyBankAccount(accountNumber, bankCode);
    console.log(
      `[BANK] verify-bank responded success | bankCode: ${bankCode} | accountNumber: ${maskAccount(accountNumber)} | resolvedAccountName: ${data?.accountName || "—"}`
    );
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    console.log(
      `[BANK] verify-bank failed | bankCode: ${bankCode || "—"} | accountNumber: ${accountNumber ? maskAccount(accountNumber) : "missing"} | status: ${err?.statusCode || err?.status || "—"} | error: ${err?.message || err}`
    );
    next(err);
  }
};

exports.getBanksList = async (req, res, next) => {
  try {
    const data = await PaymentService.getBanks();
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    next(err);
  }
};