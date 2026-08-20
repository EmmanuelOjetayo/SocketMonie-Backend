const express = require("express");
const router = express.Router();

const adminController = require("../Controllers/AdminController");
const protect = require("../Middleware/AuthMiddleware");
const requireRole = require("../Middleware/authorize");
// ============================================================================
// GLOBAL ADMIN PROTECTION
// ============================================================================
router.use(protect);
router.use(requireRole("super_admin"));


// ============================================================================
// MEMBERS
// ============================================================================

// Get all members
router.get("/members", adminController.getMembers);

// Get single member
router.get("/members/:userId", adminController.getMemberById);

// Suspend member
router.patch("/members/:userId/suspend", adminController.suspendMember);

// Activate member
router.patch("/members/:userId/activate", adminController.activateMember);


// ============================================================================
// KYC
// ============================================================================

// Approve KYC
router.patch(
  "/members/:userId/kyc/approve",
  adminController.approveKYC
);

// Reject KYC
router.patch(
  "/members/:userId/kyc/reject",
  adminController.rejectKYC
);


// ============================================================================
// LOANS
// ============================================================================

// Get all loan applications
router.get("/loans", adminController.getLoans);

// Get single loan
router.get("/loans/:loanId", adminController.getLoanById);

// Approve loan (Automatically activates loan)
router.patch(
  "/loans/:loanId/approve",
  adminController.approveLoan
);

// Reject loan
router.patch(
  "/loans/:loanId/reject",
  adminController.rejectLoan
);
// WITHDRAWALS
router.get("/withdrawals/pending", adminController.getPendingWithdrawals);
router.post("/withdrawals/:id/approve", adminController.approveWithdrawal);
router.post("/withdrawals/:id/reject", adminController.rejectWithdrawal);


// ============================================================================
// REPORTS
// ============================================================================

// Dashboard reports
router.get("/reports", adminController.getAdminReports);

// Export PDF
router.get("/reports/pdf", adminController.downloadReportPdf);

// Export Excel
router.get("/reports/excel", adminController.downloadReportExcel);


// ============================================================================
// SETTINGS
// ============================================================================

// Get system settings
router.get("/settings", adminController.getSystemSettings);

// Update settings
router.put("/settings", adminController.updateSystemSettings);

module.exports = router;