const jwt = require("jsonwebtoken");
const Users = require("../Models/UserModel");

async function routeProtect(req, res, next) {
  let token;

  // 1. Check if Authorization header exists and uses 'Bearer' format
  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    try {
      // Get token from header
      token = req.headers.authorization.split(" ")[1];

      // Verify token
      const decodeUser = jwt.verify(token, process.env.JWT_SECRET);

      // Support both decodeUser.id and decodeUser._id from JWT payload
      const userId = decodeUser.id || decodeUser._id;

      // Get user from token payload (excluding password)
      // Automatically includes user status, role, and membershipFeePaid flag
      req.user = await Users.findById(userId).select("-password");

      if (!req.user) {
        return res.status(401).json({ message: "User no longer exists" });
      }

      // Proceed to the next middleware or controller
      return next(); 
    } catch (error) {
      // Token expired, malformed, or signature failed
      return res.status(401).json({ message: "Not authorized, token failed" });
    }
  }

  // If no token is provided at all
  if (!token) {
    return res.status(401).json({ message: "Not authorized, Please re-login" });
  }
}

module.exports = routeProtect;