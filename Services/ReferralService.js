const { ReferralRepository } = require("../Repositories/ReferralRepository");
const { createNotification } = require("../Utilis/notificationHelper");

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
  /**
   * Workflow K: referral qualification & reward lifecycle.
   *
   * Wherever one of the supported qualification events completes
   * (membership_fee_paid | first_deposit | kyc_approved), evaluate the
   * currently configured SystemSettings referralReward.qualificationEvent.
   * Only the configured event qualifies the referral; everything else is a
   * no-op. Idempotent: referrals already qualified/rewarded are never
   * re-processed, so replayed webhooks or repeated verify calls cannot
   * double-award.
   *
   * Reward money is NOT auto-credited: on qualification the reward is
   * recorded with rewardStatus "pending_payout" (and the configured amount),
   * awaiting the payout rail the finance team executes. This follows the
   * ReferralModel's rewardTransactionRef design; no fabricated cash movement.
   */
  processQualification: async (referredUserId, event) => {
    if (!referredUserId || !event) return null;

    const settings = await ReferralRepository.getRewardConfig();
    const rewardConfig = settings?.referralReward || {};
    const configuredEvent = rewardConfig.qualificationEvent || "membership_fee_paid";
    if (configuredEvent !== event) return null;

    const referral = await ReferralRepository.findUnqualifiedByReferredUser(referredUserId);
    if (!referral) return null;

    referral.status = "qualified";
    referral.qualificationEvent = event;
    referral.qualifiedAt = new Date();
    const referrerAmount = Number(rewardConfig.referrerAmount ?? 0);
    referral.referrerReward = referrerAmount;
    referral.referredUserReward = Number(rewardConfig.referredUserAmount ?? 0);
    if (referrerAmount > 0) {
      referral.rewardStatus = "pending_payout";
    }
    await ReferralRepository.saveReferral(referral);

    await createNotification({
      userId: referral.referrerId,
      type: "referral",
      title: "Referral Qualified",
      message: `Your referred member completed their ${event.replace(/_/g, " ")}. Your referral reward of ₦${referrerAmount.toLocaleString()} is pending payout.`,
      data: {
        referralId: referral._id,
        referredUserId,
        event,
        rewardAmount: referrerAmount,
        rewardStatus: referral.rewardStatus,
      },
    });

    return referral;
  },
};

module.exports = { ReferralService };
