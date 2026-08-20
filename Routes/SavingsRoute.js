const express = require("express");
const router = express.Router();
const routeProtect = require("../Middleware/AuthMiddleware");
const {
  getSavingsSummary,
  getMonthlySavingsReport,
  getSavingsHistory,
  requestWithdrawal,
  updateTierCommitment,
  initializeMembershipFee,
  verifyMembershipFee,
} = require("../Controllers/SavingsController");

// Existing routes
router.get("/summary", routeProtect, getSavingsSummary);

router.get("/report", routeProtect, getMonthlySavingsReport);
router.get("/history", routeProtect, getSavingsHistory);
// Direct withdrawal bypass route removed (H1) — all withdrawals must go through
// the admin-approval flow below. Frontend already uses this exclusively.
router.post("/withdraw-request", routeProtect, requestWithdrawal);

// NEW: Tier upgrade & commitment update route
router.put("/tier-commitment", routeProtect, updateTierCommitment);

// Membership fee paywall (implemented in the controller but never routed until now)
router.post("/membership-fee/initialize", routeProtect, initializeMembershipFee);
router.post("/membership-fee/verify", routeProtect, verifyMembershipFee);

module.exports = router;