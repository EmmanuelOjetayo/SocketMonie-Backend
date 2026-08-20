const express = require("express");
const router = express.Router();
const scoreController = require("../Controllers/ScoreController");
const protect = require("../Middleware/AuthMiddleware");
router.use(protect);
router.get("/me", scoreController.getMyScore);
router.get("/breakdown", scoreController.getBreakdown);
router.get("/history", scoreController.getScoreHistory);
module.exports = router;