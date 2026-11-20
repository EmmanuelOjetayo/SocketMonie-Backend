const { PaymentService } = require("../Services/PaymentService");

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

// Callback and browser-triggered verify handlers were removed deliberately.
// A checkout redirect is only navigation data; the signed webhook is the sole
// payment confirmation path. The read-only status endpoint below is the only
// result-page API.

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
 * of truth). Returns the webhook-confirmed outcome for a reference
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