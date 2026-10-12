const express = require("express");
const router = express.Router();
const routeProtect = require("../Middleware/AuthMiddleware");
const SavingsValidate = require("../Middleware/SavingsValidate");
const {
  getSavingsSummary,
  getMonthlySavingsReport,
  getSavingsHistory,
  requestWithdrawal,
  updateTierCommitment,
  initializeMembershipFee,
  verifyMembershipFee,
} = require("../Controllers/SavingsController");

router.get("/summary", routeProtect, getSavingsSummary);
router.get("/report", routeProtect, getMonthlySavingsReport);
router.get("/history", routeProtect, getSavingsHistory);

router.post("/withdraw-request", routeProtect, SavingsValidate.validateWithdrawRequest, requestWithdrawal);
router.put("/tier-commitment", routeProtect, SavingsValidate.validateTierCommitment, updateTierCommitment);
router.post("/membership-fee/initialize", routeProtect, initializeMembershipFee);
router.post("/membership-fee/verify", routeProtect, SavingsValidate.validateVerifyMembershipFee, verifyMembershipFee);

module.exports = router;