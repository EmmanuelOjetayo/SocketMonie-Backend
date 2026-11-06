const Referral = require("../Models/ReferralModel");
const SystemSettings = require("../Models/SystemSettingsModel");

const ReferralRepository = {
  createRegistration: (data, session) => Referral.create([data], { session }).then((records) => records[0]),
  findByReferrer: (referrerId) => Referral.find({ referrerId }).sort({ createdAt: -1 }).populate("referredUserId", "fullName email isVerified createdAt"),
  countByReferrer: (referrerId) => Referral.countDocuments({ referrerId }),
  countByReferrerAndStatus: (referrerId, status) => Referral.countDocuments({ referrerId, status }),
  countQualifiedByReferrer: (referrerId) => Referral.countDocuments({ referrerId, status: { $in: ["qualified", "rewarded"] } }),
  findUnqualifiedByReferredUser: (referredUserId) =>
    Referral.findOne({ referredUserId, status: { $in: ["registered", "verified"] } }),
  saveReferral: (doc, session = null) => (session ? doc.save({ session }) : doc.save()),
  getRewardConfig: () => SystemSettings.findOne(),
};

module.exports = { ReferralRepository };
