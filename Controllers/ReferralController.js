const User = require("../Models/UserModel");

// GET /api/referrals/activity
exports.getActivity = async (req, res, next) => {
  try {
    const userId = req.user._id;
    // For MVP, we return a mock list. In production, we'd have a Referral model.
    // For now, we'll find users who used this user's referral code.
    const referrals = await User.find({ referralCode: req.user.referralCode })
      .select("fullName email createdAt")
      .sort({ createdAt: -1 });
    const activity = referrals.map(u => ({
      name: u.fullName,
      date: u.createdAt.toISOString().split("T")[0],
      status: u.isVerified ? "active" : "pending",
    }));
    return res.status(200).json({ success: true, items: activity });
  } catch (err) {
    next(err);
  }
};

// GET /api/referrals/stats
exports.getStats = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const totalReferrals = await User.countDocuments({ referralCode: req.user.referralCode });
    // Mock points (could be stored in User or separate model)
    const pointsEarned = totalReferrals * 10;
    const rank = totalReferrals > 20 ? "Gold" : totalReferrals > 10 ? "Silver" : "Bronze";
    return res.status(200).json({
      success: true,
      stats: {
        totalReferrals,
        pointsEarned,
        rank,
      },
    });
  } catch (err) {
    next(err);
  }
};