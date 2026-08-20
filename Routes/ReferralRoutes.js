const express = require("express");
const router = express.Router();
const referralController = require("../Controllers/ReferralController");
const protect = require("../Middleware/AuthMiddleware");
router.use(protect);
router.get("/activity", referralController.getActivity);
router.get("/stats", referralController.getStats);
module.exports = router;