const { MembershipService } = require("../Services/MembershipService");

const initializeMembershipFee = async (req, res, next) => {
  try {
    const data = await MembershipService.initializeMembershipFee(req.user._id);
    return res.status(200).json({
      success: true,
      message: "Membership fee payment initialized.",
      data,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { initializeMembershipFee };
