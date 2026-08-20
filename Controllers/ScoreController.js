const User = require("../Models/UserModel");
const { calculateScore, getScoreHistory, getLatestBreakdown } = require("../Utilis/scoreService");

exports.getMyScore = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    let breakdown = await getLatestBreakdown(userId);
    if (!breakdown) {
      const result = await calculateScore(userId);
      breakdown = result.breakdown;
    }
    return res.status(200).json({
      success: true,
      data: {
        overallScore: user.socketScore || 0,
        breakdown,
        percentile: "Top 20%",
        change: 8,
      },
    });
  } catch (err) { next(err); }
};

exports.getScoreHistory = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const months = parseInt(req.query.months) || 6;
    const history = await getScoreHistory(userId, months);
    return res.status(200).json({ success: true, data: history });
  } catch (err) { next(err); }
};

exports.getBreakdown = async (req, res, next) => {
  return exports.getMyScore(req, res, next);
};