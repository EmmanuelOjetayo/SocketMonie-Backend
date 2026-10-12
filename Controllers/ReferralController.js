const { ReferralService } = require("../Services/ReferralService");

// GET /api/referrals/activity
exports.getActivity = async (req, res, next) => {
  try {
    const activity = await ReferralService.getActivity(req.user._id);
    return res.status(200).json({ success: true, items: activity });
  } catch (err) {
    next(err);
  }
};

// GET /api/referrals/stats
exports.getStats = async (req, res, next) => {
  try {
    const stats = await ReferralService.getStats(req.user._id);
    return res.status(200).json({
      success: true,
      stats,
    });
  } catch (err) {
    next(err);
  }
};