const express = require("express");
const loanRoutes = express.Router();
const loanController = require("../Controllers/LoanController");
const protect = require("../Middleware/AuthMiddleware");
const validate = require("../Middleware/validate");
const requireMembershipFee = require("../Middleware/requireMembershipFee"); // Paywall guard
const authorize = require("../Middleware/authorize"); // Role guard middleware
const { strictFinancialLimiter } = require("../Middleware/rateLimiter");
// All loan routes require authentication
loanRoutes.use(protect);
loanRoutes.use(authorize("super_admin", "financial_manager", "member"));
// loanRoutes.use(strictFinancialLimiter);
// --------------------------------------------------------------------------
// LOAN ENQUIRIES (Protected by Membership Paywall)
// --------------------------------------------------------------------------
loanRoutes.get("/eligibility", loanController.checkEligibility);
loanRoutes.get("/active", loanController.getActiveLoan);
loanRoutes.get("/history", loanController.getLoanHistory);
loanRoutes.get("/:loanId", loanController.getLoanById);
loanRoutes.get("/:loanId/schedule", loanController.getRepaymentSchedule);

// --------------------------------------------------------------------------
// LOAN ACTIONS (Applying requires paid membership fee)
// --------------------------------------------------------------------------
loanRoutes.post(
  "/apply", 
  requireMembershipFee,
  validate({ 
    amount: "required|monetary|min:100", 
    durationMonths: "required|min:1|max:12", 
    loanType: "required|string" 
  }), 
  loanController.applyForLoan
);

loanRoutes.post(
  "/repay/initialize",
  validate({
    loanId: "required|string",
    paymentAmount: "required|monetary|min:100",
  }),
  loanController.initializeLoanRepayment
);

loanRoutes.post(
  "/repay/verify",
  validate({
    loanId: "required|string",
    transactionId: "required|string",
    tx_ref: "required|string",
  }),
  loanController.verifyLoanRepayment
);

// loanRoutes.post(
//   "/repay", 
//   validate({ 
//     loanId: "required|string", 
//     paymentAmount: "required|monetary|min:100" 
//   }), 
//   loanController.repayLoan
// );

// --------------------------------------------------------------------------
// ADMIN / MANAGEMENT ACTIONS
// --------------------------------------------------------------------------
loanRoutes.put(
  "/approve/:loanId", 
  authorize("super_admin", "financial_manager"), 
  loanController.approveAndDisburseLoan
);

// AFTER
loanRoutes.post(
  "/admin/process-defaulters", 
  authorize("super_admin", "finance_manager"), 
  loanController.triggerLoanDefaulterCheck
);
module.exports = loanRoutes;