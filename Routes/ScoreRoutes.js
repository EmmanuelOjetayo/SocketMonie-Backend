const express = require("express");
const router = express.Router();
const scoreController = require("../Controllers/ScoreController");
const protect = require("../Middleware/AuthMiddleware");

/**
 * SocketScore routes — member-scoped, auth-protected.
 * Members can only ever read/modify their OWN data (req.user._id) —
 * no member can ever view or alter another member's score.
 */
router.use(protect);
router.get("/me", scoreController.getMyScore);
router.get("/summary", scoreController.getScoreSummary);
router.get("/breakdown", scoreController.getBreakdown);
router.get("/history", scoreController.getScoreHistory);
router.get("/monthly-history", scoreController.getMonthlyHistory);
router.get("/trend", scoreController.getTrend);
router.get("/explanation", scoreController.getExplanation);
router.post("/monthly/finalize", scoreController.finalizeMonthly);

module.exports = router;
