const axios = require("axios");

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_PUBLIC_KEY = process.env.FLW_PUBLIC_KEY;
const FLW_BASE_URL = "https://api.flutterwave.com/v3";

// -------------------------------------
// Verify Payment
// -------------------------------------
const verifyPayment = async (transactionId) => {
  const response = await axios.get(
    `${FLW_BASE_URL}/transactions/${transactionId}/verify`,
    {
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
      },
    }
  );

  return response.data;
};

// -------------------------------------
// Initialize Payment
// -------------------------------------
const initializePayment = async (payload, email, tx_ref, meta = {}) => {
  let requestBody;

  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    requestBody = payload;
  } else {
    requestBody = {
      tx_ref,
      amount: payload,
      currency: "NGN",
      payment_options: "card,banktransfer,ussd",
      customer: {
        email,
      },
      meta,
    };
  }

  const response = await axios.post(
    `${FLW_BASE_URL}/payments`,
    requestBody,
    {
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
      },
    }
  );

  return response.data;
};

// -------------------------------------
// Transfer (Loan Disbursement)
// -------------------------------------
const initiateTransfer = async (
  accountBank,
  accountNumber,
  amount,
  reference,
  narration = "Socket Moni Payout"
) => {
  const response = await axios.post(
    `${FLW_BASE_URL}/transfers`,
    {
      account_bank: accountBank,
      account_number: accountNumber,
      amount,
      narration,
      currency: "NGN",
      reference,
      callback_url: `${process.env.BACKEND_URL}/api/payments/webhook`,
      debit_currency: "NGN",
    },
    {
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
      },
    }
  );

  return response.data;
};

// -------------------------------------
// Get Banks
// -------------------------------------
const getBanks = async () => {
  const response = await axios.get(
    `${FLW_BASE_URL}/banks/NG`,
    {
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
      },
    }
  );

  return response.data;
};

// -------------------------------------
// Resolve Account
// -------------------------------------
const verifyAccount = async (accountNumber, bankCode) => {
  const response = await axios.post(
    `${FLW_BASE_URL}/accounts/resolve`,
    {
      account_number: accountNumber,
      account_bank: bankCode,
    },
    {
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
      },
    }
  );

  return response.data;
};

module.exports = {
  initializePayment,
  verifyPayment,
  initiateTransfer,
  getBanks,
  verifyAccount,
};