const express = require("express");
const router = express.Router();
const paymentController = require("../Controllers/PaymentController");
const protect = require("../Middleware/AuthMiddleware");
const validate = require("../Middleware/validate");

// ======================== DEPOSIT FLOW ========================

// POST /api/payments/deposit/initiate — Initiate a savings deposit via Paystack Popup
router.post("/deposit/initiate", protect, validate({ amount: "required|monetary|min:100" }), paymentController.initiateDeposit);

// GET /api/payments/deposit/callback — redirect callback after payment (hosted-redirect flow only)
router.get("/deposit/callback", paymentController.paymentCallback); // no auth needed for callback
router.post(
  "/deposit/verify",
  protect,
  paymentController.verifyDeposit
);
// POST /api/payments/webhook — Paystack webhook (public, HMAC-SHA512 signature verified inside
// against req.rawBody — see app.js's express.json({ verify }) hook)
router.post("/webhook", paymentController.webhook); // public webhook


// ======================== WITHDRAWAL PAYOUT FLOW ========================

// // POST /api/payments/withdraw/payout — Initiate withdrawal payout via Paystack transfer (admin/finance only)
// router.post("/withdraw/payout", protect, validate({ withdrawalId: "required|string", amount: "required|monetary|min:100", bankCode: "required|string", accountNumber: "required|string" }), paymentController.initiateWithdrawalPayout);

// ======================== BANK VERIFICATION ========================

// POST /api/payments/verify-bank — Verify a bank account using Paystack
router.post("/verify-bank", protect, validate({ accountNumber: "required|string", bankCode: "required|string" }), paymentController.verifyBankAccount);

// GET /api/payments/banks — Get list of Nigerian banks from Paystack
router.get("/banks", protect, paymentController.getBanksList);

module.exports = router;