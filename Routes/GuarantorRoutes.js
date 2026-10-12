const express = require("express");
const guarantorRoutes = express.Router();
const guarantorController = require("../Controllers/GuarantorController");
const protect = require("../Middleware/AuthMiddleware");
const authorize = require("../Middleware/authorize");
const GuarantorValidate = require("../Middleware/GuarantorValidate");

// Public / Token verification route
guarantorRoutes.get("/verify/:token", guarantorController.getGuarantorDetails);

// Respond to guarantor invitation
guarantorRoutes.post(
  "/respond",
  protect,
  GuarantorValidate.validateRespondGuarantor,
  guarantorController.respondToGuarantorRequest
);

// Protected Routes
guarantorRoutes.use(protect);
guarantorRoutes.get("/pending-requests", guarantorController.getPendingGuarantorRequests);
guarantorRoutes.get("/search/:referralCode", guarantorController.searchGuarantor);
guarantorRoutes.get("/loan/:loanId", guarantorController.getGuarantorByLoan);

if (typeof guarantorController.getGuarantorDetailsAdmin === "function") {
  guarantorRoutes.get(
    "/admin/loan/:loanId",
    authorize("super_admin", "finance_manager"),
    guarantorController.getGuarantorDetailsAdmin
  );
}

module.exports = guarantorRoutes;