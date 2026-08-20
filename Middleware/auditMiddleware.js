const { logAudit } = require("../Utilis/auditLogger");

/**
 * Middleware to automatically log audit events for authenticated routes.
 * It can be used as a function or as a wrapper.
 * 
 * Usage:
 *   router.post("/something", auditMiddleware('action_name', 'target_type'), handler);
 * 
 * @param {string} action - The action key (must be in AuditLog schema enum)
 * @param {string} targetType - The target type (user, loan, savings, tier, system)
 * @param {Function} getTargetId - Optional function to extract target ID from req
 * @param {Function} getDetails - Optional function to extract additional details from req
 * @returns {Function} Express middleware
 */
const auditMiddleware = (action, targetType = 'system', getTargetId = null, getDetails = null) => {
  return async (req, res, next) => {
    // Store original send/end to capture response if needed
    // But we want to log after the request completes, so we'll listen to finish event
    // However, to keep it simple, we'll log before the handler runs and after.
    // Since the audit log should capture the action, we can log after the handler completes.
    // We'll override res.end to capture the response status.
    const originalEnd = res.end;
    let bodyChunks = [];

    res.end = function (chunk) {
      if (chunk) bodyChunks.push(chunk);
      originalEnd.apply(res, arguments);
    };

    // We'll log after the response is sent.
    // We'll attach a listener to the 'finish' event.
    res.on('finish', () => {
      const statusCode = res.statusCode;
      // Only log if status is 2xx or 4xx (success or client error)
      // We'll log anyway but include status.
      const userId = req.user?._id || null;
      const userEmail = req.user?.email || null;
      const userRole = req.user?.role || null;
      const ipAddress = req.ip || req.connection?.remoteAddress || null;
      const userAgent = req.headers['user-agent'] || null;
      const targetId = getTargetId ? getTargetId(req) : null;
      const details = getDetails ? getDetails(req) : {};

      // Add response status
      details.responseStatus = statusCode;

      // For errors, maybe include error message from response?
      // Not easily accessible, but we can add if available.

      logAudit({
        userId,
        userEmail,
        userRole,
        action,
        targetType,
        targetId,
        details,
        ipAddress,
        userAgent,
      }).catch(console.error);
    });

    next();
  };
};

module.exports = { auditMiddleware };