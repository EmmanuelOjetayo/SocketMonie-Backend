const express = require("express");
const router = express.Router();
const complaintController = require("../Controllers/ComplaintController");
const protect = require("../Middleware/AuthMiddleware");
router.use(protect);
router.get("/mine", complaintController.getMyComplaints);
router.post("/", complaintController.submitComplaint);
module.exports = router;