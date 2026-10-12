const express = require("express");
const router = express.Router();
const adminController = require("../Controllers/AdminController");
const protect = require("../Middleware/AuthMiddleware");
const requireRole = require("../Middleware/authorize");
const AdminValidate = require("../Middleware/AdminValidate");
const scoreController = require("../Controllers/ScoreController");

// Global Admin Protection
router.use(protect);
router.use(requireRole("super_admin"));

// Members
router.get("/members", adminController.getMembers);
router.get("/members/:userId", adminController.getMemberById);
router.patch("/members/:userId/suspend", adminController.suspendMember);
router.patch("/members/:userId/activate", adminController.activateMember);

// KYC
router.patch("/members/:userId/kyc/approve", adminController.approveKYC);
router.patch("/members/:userId/kyc/reject", AdminValidate.validateReason, adminController.rejectKYC);

// Loans
router.get("/loans", adminController.getLoans);
router.get("/loans/:loanId", adminController.getLoanById);
router.patch("/loans/:loanId/approve", adminController.approveLoan);
router.patch("/loans/:loanId/reject", AdminValidate.validateReason, adminController.rejectLoan);

// Withdrawals
router.get("/withdrawals/pending", adminController.getPendingWithdrawals);
router.post("/withdrawals/:id/approve", adminController.approveWithdrawal);
router.post("/withdrawals/:id/reject", AdminValidate.validateReason, adminController.rejectWithdrawal);

// Reports
router.get("/reports", adminController.getAdminReports);
router.get("/reports/pdf", adminController.downloadReportPdf);
router.get("/reports/excel", adminController.downloadReportExcel);

// Settings
router.get("/settings", adminController.getSystemSettings);
router.put("/settings", AdminValidate.validateSystemSettings, adminController.updateSystemSettings);

// SocketScore configuration is versioned and restricted to Super Admins.
router.get("/score/config", scoreController.getActiveConfig);
router.get("/score/config/history", scoreController.getConfigHistory);
router.put("/score/config", scoreController.updateScoringConfig);

module.exports = router;