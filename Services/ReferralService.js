const { ReferralRepository } = require("../Repositories/ReferralRepository");

const ReferralService = {
  getActivity: async (referrerId) => {
    const referrals = await ReferralRepository.findByReferrer(referrerId);
    return referrals.map((referral) => ({
      id: referral._id,
      name: referral.referredUserId?.fullName,
      email: referral.referredUserId?.email,
      date: referral.createdAt.toISOString().split("T")[0],
      status: referral.status,
      qualificationEvent: referral.qualificationEvent,
      qualifiedAt: referral.qualifiedAt,
      rewardStatus: referral.rewardStatus,
      rewardAmount: referral.referrerReward,
    }));
  },
  getStats: async (referrerId) => {
    const [totalReferrals, qualifiedReferrals, rewardedReferrals] = await Promise.all([
      ReferralRepository.countByReferrer(referrerId),
      ReferralRepository.countQualifiedByReferrer(referrerId),
      ReferralRepository.countByReferrerAndStatus(referrerId, "rewarded"),
    ]);
    return { totalReferrals, qualifiedReferrals, rewardedReferrals };
  },
};

module.exports = { ReferralService };