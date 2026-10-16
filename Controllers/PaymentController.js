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

    // Normalize status: Flutterwave may send "successful", "completed", "success",
    // "paid", "authorised", or other status strings
    const normalizedStatus = (status || "").toLowerCase();
    const isSuccessStatus =
      normalizedStatus === "successful" ||
      normalizedStatus === "completed" ||
      normalizedStatus === "success" ||
      normalizedStatus === "paid" ||
      normalizedStatus === "authorised" ||
      normalizedStatus === "accepted" ||
      normalizedStatus === "transfer_successful";

    const redirectBase =
      isSuccessStatus ||
      normalizedStatus === "transfer_successful"
        ? `${process.env.FRONTEND_URL}/payments/savings/success`
        : `${process.env.FRONTEND_URL}/payments/savings/failed`;

    return res.redirect(`${redirectBase}?${params.join("&")}`);
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
      return res.status(200).json({ success: true, message: "Already verified" });
    }

    return res.status(200).json({
      success: true,
      message: "Verified successfully",
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

exports.verifyBankAccount = async (req, res, next) => {
  try {
    const { accountNumber, bankCode } = req.body;
    const data = await PaymentService.verifyBankAccount(accountNumber, bankCode);
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
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