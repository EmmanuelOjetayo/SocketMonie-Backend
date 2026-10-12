const jwt = require("jsonwebtoken");
const Users = require("../Models/UserModel");

async function routeProtect(req, res, next) {
  let token;

  // 1. Check cookie first (preferred method)
  if (req.cookies && req.cookies.socketmoni_token) {
    token = req.cookies.socketmoni_token;
  }
  // 2. Fall back to Authorization header (backward compatibility)
  else if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({ message: "Not authorized, Please re-login" });
  }

  try {
    // Verify token (HS256 only — rejects alg:none / algorithm confusion)
    const decodeUser = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
    });

    // Support both decodeUser.id and decodeUser._id from JWT payload
    const userId = decodeUser.id || decodeUser._id;

    // Get user from token payload (excluding password)
    // Automatically includes user status, role, and membershipFeePaid flag
    req.user = await Users.findById(userId).select(
      "-password -otp -otpExpiresAt -resetPasswordOTP -resetPasswordOTPExpiresAt -pinResetOTP -pinResetOTPExpiresAt"
    );

    if (!req.user) {
      return res.status(401).json({ message: "User no longer exists" });
    }

    // Suspended accounts lose API access immediately — not just at login.
    if (req.user.status === "suspended") {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended. Please contact support.",
      });
    }

    // Proceed to the next middleware or controller
    return next();
  } catch (error) {
    // Token expired, malformed, or signature failed
    return res.status(401).json({ message: "Not authorized, token failed" });
  }
}

module.exports = routeProtect;
