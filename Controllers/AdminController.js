const { AdminService } = require("../Services/AdminService");
const { LoanService } = require("../Services/LoanService");

// ==================== MEMBER MANAGEMENT ====================

exports.getMembers = async (req, res, next) => {
  try {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 20);
    const result = await AdminService.getMembers({
      page,
      limit,
      status: req.query.status,
      search: req.query.search,
    });

    return res.status(200).json({
      success: true,
      members: result.members,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};

exports.getMemberById = async (req, res, next) => {
  try {
    const result = await AdminService.getMemberDetails(req.params.userId);
    return res.status(200).json({
      success: true,
      member: result.member,
      stats: result.stats,
      scoreHistory: result.scoreHistory,
    });
  } catch (error) {
    next(error);
  }
};

exports.suspendMember = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    await AdminService.setMemberStatus(userId, "suspended", reason, req.user, req.ip, req.headers["user-agent"]);
    return res.status(200).json({ success: true, message: "Member suspended." });
  } catch (err) {
    next(err);
  }
};

exports.activateMember = async (req, res, next) => {
  try {
    const { userId } = req.params;
    await AdminService.setMemberStatus(userId, "completed", "", req.user, req.ip, req.headers["user-agent"]);
    return res.status(200).json({ success: true, message: "Member activated." });
  } catch (err) {
    next(err);
  }
};

// ==================== KYC ====================

exports.approveKYC = async (req, res, next) => {
  try {
    const { userId } = req.params;
    await AdminService.updateKyc(userId, "approved", "", req.user, req.ip, req.headers["user-agent"]);
    return res.status(200).json({ success: true, message: "KYC approved." });
  } catch (err) {
    next(err);
  }
};

exports.rejectKYC = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    await AdminService.updateKyc(userId, "rejected", reason, req.user, req.ip, req.headers["user-agent"]);
    return res.status(200).json({ success: true, message: "KYC rejected." });
  } catch (err) {
    next(err);
  }
};

// ==================== LOAN MANAGEMENT ====================

exports.getLoans = async (req, res, next) => {
  try {
    const result = await AdminService.getLoans({
      status: req.query.status || "",
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 20),
      search: req.query.search || "",
    });
    return res.status(200).json({ success: true, loans: result.loans, pagination: result.pagination });
  } catch (err) {
    next(err);
  }
};

exports.getLoanById = async (req, res, next) => {
  try {
    const loan = await AdminService.getLoan(req.params.loanId);
    return res.status(200).json({ success: true, loan });
  } catch (err) {
    next(err);
  }
};

exports.approveLoan = async (req, res, next) => {
  try {
    const loan = await LoanService.approveAndDisburseLoan({
      loanId: req.params.loanId,
      adminUser: req.user,
    });
    return res.status(200).json({
      success: true,
      message: "Loan approved and disbursed successfully.",
      loan,
    });
  } catch (err) {
    next(err);
  }
};

exports.rejectLoan = async (req, res, next) => {
  try {
    const { loanId } = req.params;
    const { reason } = req.body;
    const loan = await AdminService.rejectLoan(loanId, reason, req.user, req.ip, req.headers["user-agent"]);
    return res.status(200).json({
      success: true,
      message: "Loan rejected successfully.",
      loan,
    });
  } catch (err) {
    next(err);
  }
};

// ==================== SYSTEM SETTINGS ====================

exports.getSystemSettings = async (req, res, next) => {
  try {
    const settings = await AdminService.getSettings();
    return res.status(200).json({ success: true, settings });
  } catch (err) {
    next(err);
  }
};

exports.updateSystemSettings = async (req, res, next) => {
  try {
    const result = await AdminService.updateSystemSettings(req.body, req.user, req.ip, req.headers["user-agent"]);
    return res.status(200).json({
      success: true,
      message: "Settings updated successfully.",
      changedFields: result.changedFields,
      settings: result.settings,
    });
  } catch (err) {
    next(err);
  }
};

exports.getTierUpgradeRequests = async (req, res, next) => {
  try {
    const result = await AdminService.getTierRequests({
      status: req.query.status || "pending",
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 20),
    });
    return res.status(200).json({ success: true, data: result.users, pagination: result.pagination });
  } catch (err) {
    next(err);
  }
};

// ==================== REPORTS ====================

exports.getAdminReports = async (req, res, next) => {
  try {
    const { type = "overview", month, year } = req.query;
    const result = await AdminService.getAdminReports({ type, month, year });
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err) {
    next(err);
  }
};

exports.downloadReportPdf = async (req, res) => {
  return res.status(501).json({
    success: false,
    message: "PDF export not implemented yet.",
  });
};

exports.downloadReportExcel = async (req, res) => {
  return res.status(501).json({
    success: false,
    message: "Excel export not implemented yet.",
  });
};

// ==================== WITHDRAWALS ====================

exports.getPendingWithdrawals = async (req, res, next) => {
  try {
    const result = await AdminService.getPendingWithdrawals({
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 20),
    });
    return res.status(200).json({
      success: true,
      data: result.withdrawals,
      pagination: result.pagination,
    });
  } catch (err) {
    next(err);
  }
};

exports.approveWithdrawal = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await AdminService.approveWithdrawal(id, req.user, req.ip, req.headers["user-agent"]);
    return res.status(200).json({
      success: true,
      message: "Withdrawal approved successfully.",
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

exports.rejectWithdrawal = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    await AdminService.rejectWithdrawal(id, reason, req.user);
    return res.status(200).json({
      success: true,
      message: "Withdrawal rejected.",
    });
  } catch (err) {
    next(err);
  }
};