/**
 * Role gate — use AFTER routeProtect (AuthMiddleware) so req.user is already populated.
 * Usage: router.put("/policy", routeProtect, requireRole("super_admin"), updatePolicy);
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Not authorized, no user context." });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action.",
      });
    }

    return next();
  };
}

module.exports = requireRole;