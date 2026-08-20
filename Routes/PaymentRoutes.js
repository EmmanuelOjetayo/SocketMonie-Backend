const express = require("express");
const router = express.Router();
const paymentController = require("../Controllers/PaymentController");
const protect = require("../Middleware/AuthMiddleware");
const validate = require("../Middleware/validate");

// ======================== DEPOSIT FLOW ========================

// POST /api/payments/deposit/initiate — Initiate a savings deposit via Flutterwave (card/online payment)
router.post("/deposit/initiate", protect, validate({ amount: "required|monetary|min:100" }), paymentController.initiateDeposit);

// GET /api/payments/deposit/callback — Flutterwave redirect callback after payment
router.get("/deposit/callback", paymentController.paymentCallback); // no auth needed for callback
router.post(
  "/deposit/verify",
  protect,
  paymentController.verifyDeposit
);
// POST /api/payments/webhook — Flutterwave webhook (public, signature verified inside)
router.post("/webhook", paymentController.webhook); // public webhook


// ======================== WITHDRAWAL PAYOUT FLOW ========================

// // POST /api/payments/withdraw/payout — Initiate withdrawal payout via Flutterwave transfer (admin/finance only)
// router.post("/withdraw/payout", protect, validate({ withdrawalId: "required|string", amount: "required|monetary|min:100", bankCode: "required|string", accountNumber: "required|string" }), paymentController.initiateWithdrawalPayout);

// ======================== BANK VERIFICATION ========================

// POST /api/payments/verify-bank — Verify a bank account using Flutterwave
router.post("/verify-bank", protect, validate({ accountNumber: "required|string", bankCode: "required|string" }), paymentController.verifyBankAccount);

// GET /api/payments/banks — Get list of Nigerian banks from Flutterwave
router.get("/banks", protect, paymentController.getBanksList);

module.exports = router;
