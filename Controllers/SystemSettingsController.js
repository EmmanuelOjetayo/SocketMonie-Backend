const SystemSettings = require("../Models/SystemSettingsModel");
const AuditLog = require("../Models/AuditLogModel");
const { logAudit } = require("../Utilis/auditLogger");

// GET /api/settings
// Fetch current global system configuration (Public/Authenticated)
exports.getSystemSettings = async (req, res, next) => {
  try {
    let settings = await SystemSettings.findOne();
    if (!settings) {
      settings = await SystemSettings.create({});
    }

    return res.status(200).json({
      success: true,
      data: settings,
    });
  } catch (err) {
    next(err);
  }
};

// PUT /api/settings
// Update global system settings (Super Admin restricted)
exports.updateSystemSettings = async (req, res, next) => {
  try {
    let settings = await SystemSettings.findOne();
    if (!settings) {
      settings = new SystemSettings();
    }

    const previousSettings = settings.toObject();

    // Fields that can be dynamically updated
    const allowedFields = [
      "loanInterestRate",
      "maxLoanToSavingsRatio",
      "membershipFeeAmount",
      "penaltyRatePerMonth",
      "gracePeriodDays",
      "maxActiveLoansPerUser",
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        settings[field] = req.body[field];
      }
    });

    await settings.save();

    // Log action to audit trail
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: "system_settings_updated",
      targetType: "system_settings",
      targetId: settings._id,
      details: {
        previous: previousSettings,
        updated: settings.toObject(),
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({
      success: true,
      message: "System settings updated successfully.",
      data: settings,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/settings/audit-logs
// View paginated audit logs with optional filters (Super Admin / Financial Manager)
// GET /api/settings/audit-logs
exports.getAuditLogs = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const { action, targetType, actorId } = req.query;

    const filter = {};
    if (action) filter.action = action;
    if (targetType) filter.targetType = targetType;
    if (actorId) filter.actorId = actorId;

    const totalLogs = await AuditLog.countDocuments(filter);
    const logs = await AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("actorId", "fullName email role");

    return res.status(200).json({
      success: true,
      meta: {
        totalLogs,
        page,
        pages: Math.ceil(totalLogs / limit),
        limit,
      },
      data: logs,
    });
  } catch (err) {
    next(err);
  }
};