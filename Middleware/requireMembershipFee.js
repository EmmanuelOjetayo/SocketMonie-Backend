/**
 * Zero-Trust Middleware: Enforces Membership Fee Payment
 * Blocks un-paid members from accessing cooperative financial features.
 */
const requireMembershipFee = (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ 
        success: false, 
        message: "Unauthorized. Authentication required." 
      });
    }

    if (!req.user.membershipFeePaid) {
      return res.status(403).json({
        success: false,
        requiresMembershipFee: true,
        message: "Membership registration fee payment required to unlock cooperative savings and loan features.",
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = requireMembershipFee;