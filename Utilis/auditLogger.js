const AuditLog = require("../Models/AuditLogModel");

/**
 * Log an audit event.
 * @param {Object} params
 * @param {string} params.userId - Actor ID (req.user._id or actorId)
 * @param {string} [params.actorId] - Alias for userId
 * @param {string} [params.userEmail] - Actor email
 * @param {string} [params.actorEmail] - Alias for userEmail
 * @param {string} [params.userRole] - Actor role
 * @param {string} [params.actorRole] - Alias for userRole
 * @param {string} params.action - Action key
 * @param {string} [params.targetType='system'] - Target category ('user', 'loan', 'savings', 'tier', 'system')
 * @param {string} [params.targetId=null] - ID of the target entity
 * @param {Object} [params.details={}] - Extra payload/metadata
 * @param {Object} [params.metadata={}] - Alias for details
 * @param {string} [params.getipAddress=null] - Request IP
 * @param {string} [params.userAgent=null] - Request User Agent
 */
const logAudit = async ({
  userId,
  actorId,
  userEmail = null,
  actorEmail = null,
  userRole = "member",
  actorRole = null,
  action,
  targetType = "system",
  targetId = null,
  details = {},
  metadata = {},
  ipAddress = null,
  userAgent = null,
}) => {
  try {
    await AuditLog.create({
      actorId: actorId || userId,
      actorEmail: actorEmail || userEmail,
      actorRole: actorRole || userRole,
      action,
      targetType,
      targetId,
      metadata: Object.keys(metadata).length > 0 ? metadata : details,
      ipAddress,
      userAgent,
    });
  } catch (err) {
    console.error("❌ Failed to log audit event:", err.message);
  }
};

module.exports = { logAudit };