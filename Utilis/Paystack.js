const axios = require("axios");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;
const PAYSTACK_BASE_URL = "https://api.paystack.co";

const client = axios.create({
  baseURL: PAYSTACK_BASE_URL,
  headers: {
    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
});

// -------------------------------------
// Verify Payment
// Paystack verifies by `reference`, not a numeric transaction id.
// NOTE: response is normalized to look like the old Flutterwave shape
// (status: "success"/"error", data.status: "successful"/"failed", amounts
// in NAIRA) so existing controller code that checks those fields keeps
// working with minimal edits. Raw Paystack values are preserved alongside
// under *_raw / amount_kobo for anything that needs them directly.
// -------------------------------------
const verifyPayment = async (reference) => {
  const response = await client.get(`/transaction/verify/${encodeURIComponent(reference)}`);
  const body = response.data; // { status: true/false, message, data: {...} }

  const raw = body.data || {};
  const amountNaira = typeof raw.amount === "number" ? raw.amount / 100 : 0;

  const normalizedStatus = raw.status === "success" ? "successful" : raw.status; // "failed" | "abandoned" | etc.

  return {
    status: body.status ? "success" : "error", // top-level call succeeded/failed
    message: body.message,
    data: {
      ...raw,
      status: normalizedStatus,
      status_raw: raw.status,
      amount: amountNaira,
      amount_settled: amountNaira,
      amount_kobo: raw.amount,
      tx_ref: raw.reference,
      reference: raw.reference,
      id: raw.id, // Paystack numeric transaction id — used for idempotency, same role as old flutterwaveRef
    },
  };
};

// -------------------------------------
// Initialize Payment (server-side redirect flow / optional)
// Not required for the Popup (Inline JS) flow, where the frontend calls
// PaystackPop directly with the public key + reference we generate here.
// Kept for cases where a hosted redirect page is preferred instead.
// -------------------------------------
const initializePayment = async ({ email, amount, reference, metadata = {}, callback_url }) => {
  const response = await client.post("/transaction/initialize", {
    email,
    amount: Math.round(Number(amount) * 100), // naira -> kobo
    reference,
    metadata,
    callback_url,
  });

  return response.data; // { status, message, data: { authorization_url, access_code, reference } }
};

// -------------------------------------
// Transfer (Loan Disbursement / Withdrawal Payout)
// Paystack requires creating a transfer recipient first, then transferring
// to that recipient — a two-step process (Flutterwave did it in one call).
// -------------------------------------
const createTransferRecipient = async (accountNumber, bankCode, name) => {
  const response = await client.post("/transferrecipient", {
    type: "nuban",
    name,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: "NGN",
  });

  return response.data; // { status, data: { recipient_code, ... } }
};

const initiateTransfer = async (
  accountBank,
  accountNumber,
  amount,
  reference,
  narration = "Socket Moni Payout",
  recipientName = "Socket Moni Member"
) => {
  const recipient = await createTransferRecipient(accountNumber, accountBank, recipientName);
  const recipientCode = recipient?.data?.recipient_code;

  if (!recipientCode) {
    throw new Error("Failed to create Paystack transfer recipient.");
  }

  const response = await client.post("/transfer", {
    source: "balance",
    amount: Math.round(Number(amount) * 100), // naira -> kobo
    reference,
    recipient: recipientCode,
    reason: narration,
  });

  return response.data; // { status, data: { transfer_code, reference, status, ... } }
};

// -------------------------------------
// Get Banks
// -------------------------------------
const getBanks = async () => {
  const response = await client.get("/bank", { params: { country: "nigeria" } });
  return response.data; // { status, data: [{ name, code, ... }] }
};

// -------------------------------------
// Resolve Account
// -------------------------------------
const verifyAccount = async (accountNumber, bankCode) => {
  const response = await client.get("/bank/resolve", {
    params: { account_number: accountNumber, bank_code: bankCode },
  });

  const raw = response.data?.data || {};

  return {
    data: {
      account_number: raw.account_number,
      account_name: raw.account_name,
      bank_code: bankCode,
    },
  };
};

module.exports = {
  PAYSTACK_PUBLIC_KEY,
  initializePayment,
  verifyPayment,
  initiateTransfer,
  getBanks,
  verifyAccount,
};