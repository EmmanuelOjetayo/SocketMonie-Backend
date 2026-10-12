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

router.get("/deposit/callback", paymentController.paymentCallback);

router.post(
  "/deposit/verify",
  protect,
  PaymentValidate.validateVerifyDeposit,
  paymentController.verifyDeposit
);

router.post("/webhook", paymentController.webhook);

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
router.post("/minutes/verify", protect, MinuteController.verifyMinutes);

module.exports = router;