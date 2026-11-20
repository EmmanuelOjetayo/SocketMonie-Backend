const express = require("express");
const routeProtect = require("../Middleware/AuthMiddleware");
const { initializeMembershipFee } = require("../Controllers/MembershipController");

const MembershipRoutes = express.Router();

// Membership fee checkout initialization. Payment confirmation is
// webhook-authoritative — no callback endpoint exists for this flow.
MembershipRoutes.post("/initialize", routeProtect, initializeMembershipFee);

module.exports = MembershipRoutes;
