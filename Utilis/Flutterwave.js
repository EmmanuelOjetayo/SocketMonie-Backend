const axios = require("axios");

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY || process.env.FLWSECK || process.env.Flw_SECRET_KEY;
const FLW_PUBLIC_KEY = process.env.FLW_PUBLIC_KEY || process.env.FLWPUBK;
const FLW_BASE_URL = process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3";
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH || process.env.FLW_WEBHOOK_SECRET || "";
// Split-payment subaccount id (RS_...). Server-owned: only ever written into
// the one-time checkout payload, never logged and never persisted.
const FLW_SUBACCOUNT_ID = process.env.FLW_SUBACCOUNT_ID || "";

/**
 * Validates that the Flutterwave webhook secret hash is configured.
 * Throws an error if the secret hash is missing.
 */
const validateSecretHash = () => {
  if (!FLW_SECRET_HASH) {
    throw new Error("FLW_SECRET_HASH is not configured. Set FLW_SECRET_HASH or FLW_WEBHOOK_SECRET in your environment.");
  }
};

const client = axios.create({
  baseURL: FLW_BASE_URL,
  headers: {
    Authorization: `Bearer ${FLW_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  timeout: 20000,
});

function normalizeTransaction(raw = {}) {
  const txRef = raw.tx_ref || raw.txRef || raw.reference || null;
  return {
    status: "success",
    message: "Transaction fetched",
    data: {
      ...raw,
      id: raw.id,
      tx_ref: txRef,
      reference: txRef,
      flw_ref: raw.flw_ref || raw.flwRef || null,
      amount: Number(raw.amount ?? 0),
      charged_amount: Number(raw.charged_amount ?? raw.amount ?? 0),
      amount_settled: Number(raw.amount_settled ?? raw.amount ?? 0),
      currency: raw.currency || "NGN",
      status: raw.status,
      customer: raw.customer || {},
      meta: raw.meta || raw.metadata || {},
      metadata: raw.meta || raw.metadata || {},
      payment_type: raw.payment_type || raw.paymentType || null,
    },
  };
}

const flwError = (message, statusCode, flwResponse) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.flwResponse = flwResponse;
  return err;
};

const verifyTransactionById = async (transactionId) => {
  try {
    const response = await client.get(`/transactions/${encodeURIComponent(String(transactionId))}/verify`);
    const body = response.data;
    if (!body || body.status !== "success" || !body.data) {
      throw flwError(body?.message || "Flutterwave verification failed.", 400, body);
    }
    return normalizeTransaction(body.data);
  } catch (err) {
    if (err.statusCode) throw err;
    const flwMsg = err.response?.data?.message || err.message;
    throw flwError(flwMsg || "Flutterwave verification failed.", err.response?.status || 500, err.response?.data);
  }
};

const verifyTransactionByReference = async (txRef) => {
  try {
    const response = await client.get("/transactions/verify_by_reference", {
      params: { tx_ref: txRef },
    });
    const body = response.data;
    if (!body || body.status !== "success" || !body.data) {
      throw flwError(body?.message || "Flutterwave reference lookup failed.", 400, body);
    }
    const list = Array.isArray(body.data) ? body.data : [body.data];
    if (!list.length) throw flwError("Transaction not found for reference.", 404, body);
    list.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    return normalizeTransaction(list[0]);
  } catch (err) {
    if (err.statusCode) throw err;
    const flwMsg = err.response?.data?.message || err.message;
    throw flwError(flwMsg || "Flutterwave reference lookup failed.", err.response?.status || 500, err.response?.data);
  }
};
const verifyPayment = async (referenceOrId) => {
  if (referenceOrId === undefined || referenceOrId === null || String(referenceOrId).trim() === "") {
    throw flwError("Payment reference is required.", 400);
  }
  const value = String(referenceOrId).trim();
  if (/^\d+$/.test(value)) return verifyTransactionById(value);
  return verifyTransactionByReference(value);
};

const initializePayment = async ({ email, phone_number = "", name = "", amount, currency = "NGN", tx_ref, redirect_url, meta = {}, title = "SocketMonnie", description = "" }) => {
  const response = await client.post("/payments", {
    tx_ref,
    amount: Number(amount),
    currency,
    redirect_url,
    customer: { email, phonenumber: phone_number, phone_number, name },
    customizations: { title, description },
    meta,
  });
  return response.data;
};

const initiateTransfer = async (accountBank, accountNumber, amount, reference, narration = "SocketMonnie Payout", beneficiaryName = "") => {
  const response = await client.post("/transfers", {
    account_bank: accountBank,
    account_number: accountNumber,
    amount: Number(amount),
    currency: "NGN",
    debit_currency: "NGN",
    reference: reference || `SMP_${Date.now()}`,
    narration: beneficiaryName ? `${narration} - ${beneficiaryName}` : narration,
  });
  return response.data;
};

const getTransfer = async (transferId) => {
  const response = await client.get(`/transfers/${encodeURIComponent(String(transferId))}`);
  return response.data;
};

const getBanks = async () => {
  const response = await client.get("/banks/NG");
  const body = response.data;
  const list = Array.isArray(body?.data) ? body.data : [];
  return { status: "success", data: list.map((b) => ({ name: b.name, code: b.code, id: b.id })) };
};

const verifyAccount = async (accountNumber, bankCode) => {
  const response = await client.post("/accounts/resolve", {
    account_number: accountNumber,
    account_bank: bankCode,
  });
  const raw = response.data?.data || {};
  return {
    data: {
      account_number: raw.account_number || accountNumber,
      account_name: raw.account_name || "",
      bank_code: bankCode,
    },
  };
};

module.exports = {
  FLW_PUBLIC_KEY,
  FLW_SECRET_KEY,
  FLW_SECRET_HASH,
  FLW_SUBACCOUNT_ID,
  validateSecretHash,
  verifyPayment,
  verifyTransactionById,
  verifyTransactionByReference,
  initializePayment,
  initiateTransfer,
  getTransfer,
  getBanks,
  verifyAccount,
};
