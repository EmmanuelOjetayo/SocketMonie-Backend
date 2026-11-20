const express = require("express");
const router = express.Router();
const paymentController = require("../Controllers/PaymentController");
const protect = require("../Middleware/AuthMiddleware");
const PaymentValidate = require("../Middleware/PaymentValidate");

// Deposit flow
router.post(
  "/deposit/initiate",
  protect,
  PaymentValidate.validateInitiateDeposit,
  paymentController.initiateDeposit
);

// Callback-based confirmation endpoints were removed deliberately. The browser
// redirect is only navigation; the signed webhook is the sole confirmation path.

router.post("/webhook", paymentController.webhook);

// Authoritative transaction-status polling for success pages (backend = source of truth)
router.get("/status/:reference", protect, paymentController.getPaymentStatus);

// Bank verification
router.post(
  "/verify-bank",
  protect,
  PaymentValidate.validateVerifyBank,
  paymentController.verifyBankAccount
);

router.get("/banks", protect, paymentController.getBanksList);

// Minutes
const MinuteController = require("../Controllers/MinuteController");
router.get("/minutes/due", protect, MinuteController.getMinutesDue);
router.post("/minutes/initialize", protect, MinuteController.initializeMinutes);
// /minutes/verify was removed: browser callbacks cannot confirm a payment.

module.exports = router;