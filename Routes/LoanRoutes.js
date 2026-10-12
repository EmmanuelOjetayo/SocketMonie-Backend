const express = require("express");
const loanRoutes = express.Router();
const loanController = require("../Controllers/LoanController");
const protect = require("../Middleware/AuthMiddleware");
const LoanValidate = require("../Middleware/LoanValidate");
const requireMembershipFee = require("../Middleware/requireMembershipFee");
const authorize = require("../Middleware/authorize");

loanRoutes.use(protect);
loanRoutes.use(authorize("super_admin", "finance_manager", "member"));

// Enquiries
loanRoutes.get("/eligibility", loanController.checkEligibility);
loanRoutes.get("/active", loanController.getActiveLoan);
loanRoutes.get("/history", loanController.getLoanHistory);
loanRoutes.get("/:loanId", loanController.getLoanById);
loanRoutes.get("/:loanId/schedule", loanController.getRepaymentSchedule);

// Actions
loanRoutes.post(
  "/apply",
  requireMembershipFee,
  LoanValidate.validateApplyLoan,
  loanController.applyForLoan
);

loanRoutes.post(
  "/:loanId/replace-guarantor",
  LoanValidate.validateReplaceGuarantor,
  loanController.replaceGuarantor
);

loanRoutes.post(
  "/repay/initialize",
  LoanValidate.validateRepayInitialize,
  loanController.initializeLoanRepayment
);

loanRoutes.post(
  "/repay/verify",
  LoanValidate.validateRepayVerify,
  loanController.verifyLoanRepayment
);

// Admin / Management Actions
loanRoutes.put(
  "/approve/:loanId",
  authorize("super_admin", "finance_manager"),
  loanController.approveAndDisburseLoan
);

loanRoutes.post(
  "/admin/process-defaulters",
  authorize("super_admin", "finance_manager"),
  loanController.triggerLoanDefaulterCheck
);

module.exports = loanRoutes;