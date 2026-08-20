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

// Guarantor accepts or rejects invitation
guarantorRoutes.post(
  "/respond",
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