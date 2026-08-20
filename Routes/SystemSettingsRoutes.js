const express = require("express");
const settingsRoutes = express.Router();
const systemSettingsController = require("../Controllers/SystemSettingsController");
const protect = require("../Middleware/AuthMiddleware");
const authorize = require("../Middleware/authorize");
const validate = require("../Middleware/validate");

// All settings routes require basic authentication
settingsRoutes.use(protect);

// Get global settings (Accessible to all authenticated members)
settingsRoutes.get("/", systemSettingsController.getSystemSettings);

// Update global system settings (Super Admin only)
settingsRoutes.put(
  "/",
  authorize("super_admin"),
  validate({
    loanInterestRate: "numeric|min:0|max:100",
    maxLoanToSavingsRatio: "numeric|min:1",
    membershipFeeAmount: "monetary|min:0",
    penaltyRatePerMonth: "numeric|min:0|max:100",
    gracePeriodDays: "numeric|min:0",
    maxActiveLoansPerUser: "numeric|min:1",
  }),
  systemSettingsController.updateSystemSettings
);

// View Audit Trail logs (Super Admin & Financial Manager)
// AFTER
settingsRoutes.get(
  "/audit-logs",
  authorize("super_admin", "finance_manager"),
  systemSettingsController.getAuditLogs
);

module.exports = settingsRoutes;