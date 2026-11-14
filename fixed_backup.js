const { AdminActivity } = require("../Models/AdminActivityModel");

/**
 * Log admin activity for transparency and audit trail
 * @param {Object} params - Action parameters
 * @param {String} params.action - Action type
 * @param {String} params.details - Action details
 * @param {String} params.referenceType - Entity type (expense, loan, capital, member, setting)
 * @param {String} params.referenceId - Related entity ID
 * @param {String} params.adminId - Admin who performed the action
 * @param {String} params.ipAddress - Request IP address
 * @param {String} params.userAgent - Request user agent
 */
const logAdminActivity = async ({
  action,
  details = "",
  referenceType = "",
  referenceId = null,
  adminId,
  ipAddress = "",
  userAgent = "",
}) => {
  await AdminActivity.create({
    action,
    details,
    referenceType,
    referenceId,
    adminId,
    ipAddress,
    userAgent,
  });
};

/**
 * Get admin activity history
 * @param {Object} filter - MongoDB filter options
 * @param {Object} options - Pagination options
 */
const getAdminActivityHistory = async (filter = {}, options = { page: 1, limit: 50 }) => {
  const page = Number(options.page) || 1;
  const limit = Number(options.limit) || 50;
  const skip = (page - 1) * limit;

  const [activities, total] = await Promise.all([
    AdminActivity.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("adminId", "fullName email")
      .lean(),
    AdminActivity.countDocuments(filter),
  ]);

  return {
    activities,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/**
 * Log expense creation
 */
const logExpenseCreate = async ({ adminId, expenseId, ipAddress, userAgent }) => {
  await logAdminActivity({
    action: "expense_create",
    details: `Expense created: ${expenseId}`,
    referenceType: "expense",
    referenceId: expenseId,
    adminId,
    ipAddress,
    userAgent,
  });
};

/**
 * Log expense reversal
 */
const logExpenseReverse = async ({ adminId, expenseId, reason, ipAddress, userAgent }) => {
  await logAdminActivity({
    action: "expense_reverse",
    details: `Expense reversed: ${expenseId}, Reason: ${reason}`,
    referenceType: "expense",
    referenceId: expenseId,
    adminId,
    ipAddress,
    userAgent,
  });
};

/**
 * Log capital addition
 */
const logCapitalAdd = async ({ adminId, capitalId, ipAddress, userAgent }) => {
  await logAdminActivity({
    action: "capital_add",
    details: `Capital added: ${capitalId}`,
    referenceType: "capital",
    referenceId: capitalId,
    adminId,
    ipAddress,
    userAgent,
  });
};

/**
 * Log capital deduction
 */
const logCapitalDeduct = async ({ adminId, capitalId, ipAddress, userAgent }) => {
  await logAdminActivity({
    action: "capital_deduct",
    details: `Capital deducted: ${capitalId}`,
    referenceType: "capital",
    referenceId: capitalId,
    adminId,
    ipAddress,
    userAgent,
  });
};

/**
 * Log revenue addition
 */
const logRevenueAdd = async ({ adminId, revenueId, ipAddress, userAgent }) => {
  await logAdminActivity({
    action: "revenue_add",
    details: `Revenue added: ${revenueId}`,
    referenceType: "revenue",
    referenceId: revenueId,
    adminId,
    ipAddress,
    userAgent,
  });
};

/**
 * Log loan approval
 */
const logLoanApprove = async ({ adminId, loanId, ipAddress, userAgent }) => {
  await logAdminActivity({
    action: "loan_approve",
    details: `Loan approved: ${loanId}`,
    referenceType: "loan",
    referenceId: loanId,
    adminId,
    ipAddress,
    userAgent,
  });
};

/**
 * Log loan rejection
 */
const logLoanReject = async ({ adminId, loanId, reason, ipAddress, userAgent }) => {
  await logAdminActivity({
    action: "loan_reject",
    details: `Loan rejected: ${loanId}, Reason: ${reason}`,
    referenceType: "loan",
    referenceId: loanId,
    adminId,
    ipAddress,
    userAgent,
  });
};

/**
 * Log member suspend/activate
 */
const logMemberStatusChange = async ({
  adminId,
  memberId,
  action, // "suspend" or "activate"
  ipAddress,
  userAgent,
}) => {
  const actionName = action === "suspend" ? "member_suspend" : "member_activate";
  await logAdminActivity({
    action: actionName,
    details: `${actionName}: ${memberId}`,
    referenceType: "member",
    referenceId: memberId,
    adminId,
    ipAddress,
    userAgent,
  });
};

/**
 * Log setting update
 */
const logSettingUpdate = async ({ adminId, setting, ipAddress, userAgent }) => {
  await logAdminActivity({
    action: "setting_update",
    details: `Setting updated: ${setting}`,
    referenceType: "setting",
    adminId,
    ipAddress,
    userAgent,
  });
};

module.exports = {
  logAdminActivity,
  getAdminActivityHistory,
  logExpenseCreate,
  logExpenseReverse,
  logCapitalAdd,
  logCapitalDeduct,
  logRevenueAdd,
  logLoanApprove,
  logLoanReject,
  logMemberStatusChange,
  logSettingUpdate,
};