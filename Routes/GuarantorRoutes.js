const express = require("express");
const guarantorRoutes = express.Router();

const guarantorController = require("../Controllers/GuarantorController");

const protect = require("../Middleware/AuthMiddleware");
const authorize = require("../Middleware/authorize");
const validate = require("../Middleware/validate");

/*
|--------------------------------------------------------------------------
| Public Routes
|--------------------------------------------------------------------------
*/

// View guarantor invitation details
guarantorRoutes.get(
  "/verify/:token",
  guarantorController.getGuarantorDetails
);

// Guarantor accepts or rejects invitation.
// Requires login: the frontend shows this after the guarantor signs in (see
// item 7's post-login overlay), and the controller cross-checks the
// authenticated user against the invited guarantorUserId before accepting
// or rejecting on their behalf.
guarantorRoutes.post(
  "/respond",
  protect,
  validate({
    token: "required|string",
    decision: "required|string",
  }),
  guarantorController.respondToGuarantorRequest
);

/*
|--------------------------------------------------------------------------
| Protected Routes
|--------------------------------------------------------------------------
*/

guarantorRoutes.use(protect);

// Get pending guarantor requests for logged in user
guarantorRoutes.get(
  "/pending-requests",
  guarantorController.getPendingGuarantorRequests
);

// Search guarantor by referral code
guarantorRoutes.get(
  "/search/:referralCode",
  guarantorController.searchGuarantor
);

// Borrower/Admin views guarantor attached to a loan
guarantorRoutes.get(
  "/loan/:loanId",
  guarantorController.getGuarantorByLoan
);

// Admin only (ONLY if this function exists)
if (typeof guarantorController.getGuarantorDetailsAdmin === "function") {
  guarantorRoutes.get(
    "/admin/loan/:loanId",
    authorize("super_admin", "finance_manager"),
    guarantorController.getGuarantorDetailsAdmin
  );
}

module.exports = guarantorRoutes;