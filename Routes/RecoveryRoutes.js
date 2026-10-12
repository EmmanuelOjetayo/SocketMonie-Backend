const express = require("express");
const router = express.Router();
const protect = require("../Middleware/AuthMiddleware");
const authorize = require("../Middleware/authorize");
const recoveryController = require("../Controllers/RecoveryController");
const validate = require("../Middleware/validate");

router.use(protect);
router.get("/obligations", authorize("member"), recoveryController.list);
router.post("/:obligationId/pay", authorize("member"), validate({ amount: "required|monetary" }), recoveryController.createPayment);
router.post("/complete", authorize("member"), validate({ reference: "required|string", providerReference: "string" }), recoveryController.completePayment);

module.exports = router;