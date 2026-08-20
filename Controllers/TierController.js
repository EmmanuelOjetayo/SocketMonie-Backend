const User = require("../Models/UserModel");
const { createNotification } = require("../Utilis/notificationHelper");
const { getTierDetails, meetsKYCForTier, getAllTiers, canUpgradeToTier } = require("../Utilis/tierService");
const { updateUserScore } = require("../Utilis/scoreService");
const { logAudit } = require("../Utilis/auditLogger");

exports.getMyTierInfo = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    const currentTier = (user.tier || 'Bronze').toLowerCase();

    const tierDetails = getTierDetails(currentTier);
    const pendingRequest = user.tierUpgradeRequest?.status === 'pending';
    const requestedTier = pendingRequest ? user.tierUpgradeRequest.requestedTier : null;
    const tierEligibility = {};
    const tiers = Object.keys(getAllTiers());
    tiers.forEach(tier => {
      const kycCheck = meetsKYCForTier(user, tier);
      tierEligibility[tier] = {
        tier,
        meetsKYC: kycCheck.meets,
        missingKYC: kycCheck.missing,
        canUpgrade: canUpgradeToTier(user, tier).canUpgrade,
      };
    });
    return res.status(200).json({
      success: true,
      data: {
        currentTier,
        tierDetails,
        pendingUpgradeRequest: pendingRequest ? { requestedTier, status: user.tierUpgradeRequest.status, submittedAt: user.tierUpgradeRequest.submittedAt } : null,
        tierEligibility,
        monthlySavingsCommitment: user.monthlySavingsCommitment,
        socketScore: user.socketScore,
      },
    });
  } catch (err) { next(err); }
};

exports.requestUpgrade = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { requestedTier } = req.body;
    const allowed = ['bronze', 'silver', 'gold', 'platinum'];
    if (!allowed.includes(requestedTier)) return res.status(400).json({ success: false, message: "Invalid tier requested." });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    if (user.tierUpgradeRequest && user.tierUpgradeRequest.status === 'pending') {
      return res.status(400).json({ success: false, message: "You already have a pending upgrade request." });
    }
    // AFTER
    const tierOrder = ['bronze', 'silver', 'gold', 'platinum'];
    const currentIndex = tierOrder.indexOf((user.tier || 'Bronze').toLowerCase());
    
    const targetIndex = tierOrder.indexOf(requestedTier);
    if (targetIndex <= currentIndex) {
      return res.status(400).json({ success: false, message: "You are already at or above this tier." });
    }
    const kycCheck = meetsKYCForTier(user, requestedTier);
    if (!kycCheck.meets) {
      return res.status(400).json({
        success: false,
        message: `Missing KYC requirements: ${kycCheck.missing.join(', ')}. Please complete your KYC first.`,
        missing: kycCheck.missing,
      });
    }
    user.tierUpgradeRequest = {
      requestedTier,
      status: 'pending',
      submittedAt: new Date(),
    };
    await user.save();
    await createNotification({
      userId: user._id,
      type: "system",
      title: "Tier Upgrade Requested",
      message: `Your request to upgrade to ${requestedTier.charAt(0).toUpperCase() + requestedTier.slice(1)} tier has been submitted for review.`,
    });
    return res.status(200).json({
      success: true,
      message: "Upgrade request submitted successfully. Please wait for admin approval.",
      data: { requestedTier, status: 'pending', submittedAt: user.tierUpgradeRequest.submittedAt },
    });
  } catch (err) { next(err); }
};

exports.approveUpgrade = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    const request = user.tierUpgradeRequest;
    if (!request || request.status !== 'pending') {
      return res.status(400).json({ success: false, message: "No pending upgrade request found." });
    }
    const kycCheck = meetsKYCForTier(user, request.requestedTier);
    if (!kycCheck.meets) {
      return res.status(400).json({
        success: false,
        message: `User does not meet KYC requirements for ${request.requestedTier} tier. Missing: ${kycCheck.missing.join(', ')}`,
      });
    }
   // AFTER
    const previousTier = user.tier;
    user.tier = request.requestedTier.charAt(0).toUpperCase() + request.requestedTier.slice(1);

    user.tierUpgradeRequest.status = 'approved';
    user.tierUpgradeRequest.reviewedAt = new Date();
    user.tierUpgradeRequest.reviewerId = req.user._id;
    user.tierUpgradeRequest.reason = reason || null;
    await user.save();
    await updateUserScore(user._id, 'tier_upgrade_approved');
    await createNotification({
      userId: user._id,
      type: "system",
      title: "Tier Upgrade Approved",
      message: `Your upgrade to ${request.requestedTier.charAt(0).toUpperCase() + request.requestedTier.slice(1)} tier has been approved!`,
    });
    // Audit log
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'tier_upgrade_approve',
      targetType: 'tier',
      targetId: userId,
      details: { previousTier, newTier: request.requestedTier, approvedBy: req.user._id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
 // AFTER
    return res.status(200).json({ success: true, message: "Tier upgrade approved.", data: { previousTier, newTier: user.tier } });
  } catch (err) { next(err); }
};

exports.rejectUpgrade = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: "Rejection reason is required." });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    const request = user.tierUpgradeRequest;
    if (!request || request.status !== 'pending') {
      return res.status(400).json({ success: false, message: "No pending upgrade request found." });
    }
    user.tierUpgradeRequest.status = 'rejected';
    user.tierUpgradeRequest.reviewedAt = new Date();
    user.tierUpgradeRequest.reviewerId = req.user._id;
    user.tierUpgradeRequest.reason = reason;
    await user.save();
    await createNotification({
      userId: user._id,
      type: "system",
      title: "Tier Upgrade Rejected",
      message: `Your upgrade request to ${request.requestedTier.charAt(0).toUpperCase() + request.requestedTier.slice(1)} tier was rejected. Reason: ${reason}`,
    });
    // Audit log
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'tier_upgrade_reject',
      targetType: 'tier',
      targetId: userId,
      details: { reason, rejectedBy: req.user._id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return res.status(200).json({ success: true, message: "Tier upgrade rejected." });
  } catch (err) { next(err); }
};


exports.getAllTiersInfo = async (req, res, next) => {
  try {
    const tiers = getAllTiers();
    const tierList = Object.keys(tiers).map(key => ({ tier: key, ...tiers[key] }));
    return res.status(200).json({ success: true, data: tierList });
  } catch (err) { next(err); }
};