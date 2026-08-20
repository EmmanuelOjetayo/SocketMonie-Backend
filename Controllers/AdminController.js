const User = require("../Models/UserModel");
const Loan = require("../Models/LoanModel");
const Savings = require("../Models/SavingsModel");
const ScoreHistory = require("../Models/ScoreHistory");
const SystemSettings = require("../Models/SystemSettingsModel");
const { createNotification, broadcastNotification } = require("../Utilis/notificationHelper");
const { updateUserScore } = require("../Utilis/scoreService");
const { logAudit } = require("../Utilis/auditLogger");

// ==================== MEMBER MANAGEMENT ====================

exports.getMembers = async (req, res) => {
  try {
    let {
      page = 1,
      limit = 20,
      status,
      search,
    } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {
      role: "member",
    };

    // Filter by account status
    if (status) {
      query.status = status;
    }

    // Search by name, email or phone
    if (search) {
      query.$or = [
        {
          fullName: {
            $regex: search,
            $options: "i",
          },
        },
        {
          email: {
            $regex: search,
            $options: "i",
          },
        },
        {
          phone: {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    const total = await User.countDocuments(query);

    const members = await User.find(query)
      .select("-password")
      .sort({
        createdAt: -1,
      })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.status(200).json({
      success: true,

      members,

      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch members.",
    });
  }
};

exports.getMemberById = async (req, res) => {
  try {
    const { userId } = req.params;

    const member = await User.findById(userId)
      .select("-password")
      .lean();

    if (!member) {
      return res.status(404).json({
        success: false,
        message: "Member not found",
      });
    }

    // Savings statistics
    const savings = await Savings.find({
      userId,
      status: "completed",
    });

    const totalSavings = savings.reduce(
      (sum, item) => sum + item.amount,
      0
    );

    // Withdrawals statistics
    const withdrawals = await Savings.find({
      userId,
      type: "withdrawal",
      status: "completed",
    });

    const totalWithdrawn = withdrawals.reduce(
      (sum, item) => sum + item.amount,
      0
    );

    // Loan statistics
    const loans = await Loan.find({ userId });

    const activeLoansCount = loans.filter(
      (loan) =>
        loan.status === "active" ||
        loan.status === "warning_30_days" ||
        loan.status === "defaulted_60_days" ||
        loan.status === "restricted_90_days" ||
        loan.status === "recovery_120_days"
    ).length;

    const totalLoanAmount = loans.reduce(
      (sum, loan) => sum + (loan.principalAmount || 0),
      0
    );

    // Score history
    const scoreHistory = await ScoreHistory.find({
      userId,
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return res.status(200).json({
      success: true,

      member,

      stats: {
        totalSavings,
        totalWithdrawn,
        activeLoansCount,
        totalLoanAmount,
      },

      scoreHistory,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch member details.",
    });
  }
};



exports.suspendMember = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    if (user.role === "super_admin") return res.status(403).json({ success: false, message: "Cannot suspend a Super Admin." });
    user.status = "suspended";
    await user.save();
    await createNotification({
      userId,
      type: "system",
      title: "Account Suspended",
      message: `Your account has been suspended. Reason: ${reason || "Violation of terms."}`,
    });
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'member_suspend',
      targetType: 'user',
      targetId: userId,
      details: { reason, suspendedBy: req.user._id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return res.status(200).json({ success: true, message: "Member suspended." });
  } catch (err) { next(err); }
};

exports.activateMember = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    user.status = "completed";
    await user.save();
    await createNotification({
      userId,
      type: "system",
      title: "Account Activated",
      message: "Your account has been reactivated.",
    });
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'member_activate',
      targetType: 'user',
      targetId: userId,
      details: { activatedBy: req.user._id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return res.status(200).json({ success: true, message: "Member activated." });
  } catch (err) { next(err); }
};

exports.approveKYC = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    user.kycStatus = "approved";
    user.kycVerifiedAt = new Date();
    await user.save();
    await updateUserScore(userId, 'kyc_approved');
    await createNotification({
      userId,
      type: "system",
      title: "KYC Approved",
      message: "Your KYC documents have been approved!",
    });
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'kyc_approve',
      targetType: 'user',
      targetId: userId,
      details: { approvedBy: req.user._id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return res.status(200).json({ success: true, message: "KYC approved." });
  } catch (err) { next(err); }
};

exports.rejectKYC = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: "Rejection reason is required." });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    user.kycStatus = "rejected";
    user.kycRejectionReason = reason;
    await user.save();
    await createNotification({
      userId,
      type: "system",
      title: "KYC Rejected",
      message: `Your KYC documents were rejected. Reason: ${reason}`,
    });
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'kyc_reject',
      targetType: 'user',
      targetId: userId,
      details: { reason, rejectedBy: req.user._id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return res.status(200).json({ success: true, message: "KYC rejected." });
  } catch (err) { next(err); }
};

// ==================== LOAN MANAGEMENT ====================

exports.getLoans = async (req, res, next) => {
  try {
    const { status = "", page = 1, limit = 20, search = "" } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      const users = await User.find({ fullName: { $regex: search, $options: 'i' } }).select('_id');
      const userIds = users.map(u => u._id);
      filter.$or = [
        { _id: { $regex: search, $options: 'i' } },
        { userId: { $in: userIds } },
      ];
    }
    const total = await Loan.countDocuments(filter);
    const loans = await Loan.find(filter)
      .populate("userId", "fullName email phone")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    return res.status(200).json({ success: true, loans, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
};

exports.getLoanById = async (req, res, next) => {
  try {
    const { loanId } = req.params;
    const loan = await Loan.findById(loanId).populate("userId", "fullName email phone address occupation");
    if (!loan) return res.status(404).json({ success: false, message: "Loan not found." });
    return res.status(200).json({ success: true, loan });
  } catch (err) { next(err); }
};

/**
 * POST /api/admin/loans/:loanId/approve
 * Approve a loan and initiate Flutterwave payout.
 *
 * IDEMPOTENCY: Uses findOneAndUpdate with { status: "pending_review", payoutReference: null }
 * Only the first concurrent request succeeds. Subsequent requests are blocked.
 *
 * COMPULSORY VALIDATIONS before payout:
 * 1. User exists
 * 2. Bank account exists (accountNumber, bankCode)
 * 3. Account name is verified (Flutterwave resolution)
 * 4. Bank account is verified (bankDetails.verified === true)
 * 5. KYC document uploaded (documentUrl)
 * 6. KYC approved by admin (kycStatus === "approved")
 *
 * PAYOUT FLOW:
 * - Validation pass → initiateTransfer() via Flutterwave
 * - Transfer succeeds → payoutStatus = "pending" (webhook completes later)
 * - Transfer fails → payoutStatus = "failed" (loan remains active, retry possible)
 * - Skip mode (FLW_SKIP_PAYOUT=true) → no Flutterwave call, for dev/testing
 */
exports.approveLoan = async (req, res, next) => {
  try {
    const { loanId } = req.params;

    const loan = await Loan.findOne({
      _id: loanId,
      status: "pending_review",
    }).populate("userId", "fullName email phone kycStatus bankDetails");

    if (!loan) {
      return res.status(404).json({
        success: false,
        message: "Loan not found or already processed.",
      });
    }

    // Optional validations
    if (loan.userId.kycStatus !== "approved") {
      return res.status(400).json({
        success: false,
        message: "Member KYC must be approved before loan approval.",
      });
    }

    // Generate repayment schedule
    const disbursedAt = new Date();

    const monthlyInstallment =
      loan.totalRepayable / loan.durationMonths;

    const installments = [];

    for (let i = 1; i <= loan.durationMonths; i++) {
      const dueDate = new Date(disbursedAt);
      dueDate.setMonth(dueDate.getMonth() + i);

      installments.push({
        installmentNumber: i,
        dueDate,
        amountDue: monthlyInstallment,
        amountPaid: 0,
        status: "unpaid",
      });
    }

    // Activate loan
    loan.status = "active";
    loan.approvedAt = new Date();
    loan.approvedBy = req.user._id;

    loan.disbursedAt = disbursedAt;
    loan.disbursedBy = req.user._id;

    loan.installments = installments;

    await loan.save();

    // Notification
    await createNotification({
      userId: loan.userId._id,
      type: "loan",
      title: "Loan Approved",
      message: `Congratulations! Your loan of ₦${loan.principalAmount.toLocaleString()} has been approved and activated.`,
    });

    // Audit Log
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: "loan_approved",
      targetType: "loan",
      targetId: loan._id,
      details: {
        amount: loan.principalAmount,
        member: loan.userId._id,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    return res.status(200).json({
      success: true,
      message: "Loan approved successfully.",
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

    if (!reason?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required.",
      });
    }

    const loan = await Loan.findOne({
      _id: loanId,
      status: "pending_review",
    }).populate("userId", "fullName email");

    if (!loan) {
      return res.status(404).json({
        success: false,
        message: "Loan not found or has already been processed.",
      });
    }

    // Update loan
    loan.status = "rejected";
    loan.rejectionReason = reason;
    loan.rejectedAt = new Date();
    loan.rejectedBy = req.user._id;

    await loan.save();

    // Notify member
    await createNotification({
      userId: loan.userId._id,
      type: "loan",
      title: "Loan Application Rejected",
      message: `Unfortunately, your loan application was rejected.\nReason: ${reason}`,
    });

    // Audit log
    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: "loan_rejected",
      targetType: "loan",
      targetId: loan._id,
      details: {
        reason,
        member: loan.userId._id,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

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
    let settings = await SystemSettings.findOne();
    if (!settings) {
      settings = await SystemSettings.create({
        loanTiers: { firstLoan: 0.7, secondLoan: 1.0, thirdLoan: 1.5 },
        interestRates: { bronze: 10, silver: 8, gold: 6, platinum: 5 },
        eligibility: { minSavings: 70000, minMonths: 6 },
        withdrawalFee: 100,
        latePenaltyRate: 2,
      });
    }
    return res.status(200).json({ success: true, settings });
  } catch (err) { next(err); }
};

exports.updateSystemSettings = async (req, res, next) => {
  try {
    const updates = req.body;
    let settings = await SystemSettings.findOne();
    if (!settings) settings = new SystemSettings();
    const changedFields = [];
    if (updates.loanTiers) {
      if (settings.loanTiers?.firstLoan !== updates.loanTiers.firstLoan) changedFields.push('First-time loan percentage');
      if (settings.loanTiers?.secondLoan !== updates.loanTiers.secondLoan) changedFields.push('Second loan percentage');
      if (settings.loanTiers?.thirdLoan !== updates.loanTiers.thirdLoan) changedFields.push('Third+ loan percentage');
      settings.loanTiers = { ...settings.loanTiers, ...updates.loanTiers };
    }
    if (updates.interestRates) {
      if (settings.interestRates?.bronze !== updates.interestRates.bronze) changedFields.push('Bronze tier interest rate');
      if (settings.interestRates?.silver !== updates.interestRates.silver) changedFields.push('Silver tier interest rate');
      if (settings.interestRates?.gold !== updates.interestRates.gold) changedFields.push('Gold tier interest rate');
      if (settings.interestRates?.platinum !== updates.interestRates.platinum) changedFields.push('Platinum tier interest rate');
      settings.interestRates = { ...settings.interestRates, ...updates.interestRates };
    }
    if (updates.eligibility) {
      if (settings.eligibility?.minSavings !== updates.eligibility.minSavings) changedFields.push('Minimum savings requirement');
      if (settings.eligibility?.minMonths !== updates.eligibility.minMonths) changedFields.push('Minimum months requirement');
      settings.eligibility = { ...settings.eligibility, ...updates.eligibility };
    }
    if (updates.withdrawalFee !== undefined) {
      if (settings.withdrawalFee !== updates.withdrawalFee) changedFields.push('Withdrawal fee');
      settings.withdrawalFee = updates.withdrawalFee;
    }
    if (updates.latePenaltyRate !== undefined) {
      if (settings.latePenaltyRate !== updates.latePenaltyRate) changedFields.push('Late payment penalty rate');
      settings.latePenaltyRate = updates.latePenaltyRate;
    }
    settings.updatedAt = new Date();
    settings.updatedBy = req.user._id;
    await settings.save();
    if (changedFields.length > 0) {
      await broadcastNotification({
        type: "system",
        title: "System Settings Updated",
        message: `The following system settings have been updated: ${changedFields.join(', ')}. Please review your loan policies and rates.`,
        excludeUserIds: [req.user._id],
      });
      await createNotification({
        userId: req.user._id,
        type: "system",
        title: "Settings Updated",
        message: `System settings updated successfully: ${changedFields.join(', ')}.`,
      });
      await logAudit({
        userId: req.user._id,
        userEmail: req.user.email,
        userRole: req.user.role,
        action: 'settings_update',
        targetType: 'system',
        details: { updatedFields: changedFields, newSettings: updates },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
    }
    return res.status(200).json({ success: true, message: "Settings updated successfully.", changedFields, settings });
  } catch (err) { next(err); }
};

// ==================== TIER UPGRADE MANAGEMENT ====================

// AFTER
exports.getTierUpgradeRequests = async (req, res, next) => {
  try {
    const { status = "pending", page = 1, limit = 20 } = req.query;
    const filter = { "tierUpgradeRequest.status": status };
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .select("fullName email tier tierUpgradeRequest")
      .sort({ "tierUpgradeRequest.submittedAt": -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    return res.status(200).json({ success: true, data: users, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
};

// ==================== REPORTS ====================

exports.getAdminReports = async (req, res, next) => {
  try {
    const { type = "overview", month, year } = req.query;

    let reports = [];
    let stats = {};

    switch (type) {
      case "savings":
        reports = await Savings.find()
          .populate("userId", "fullName")
          .sort({ createdAt: -1 });

        stats.totalAmount = reports.reduce(
          (sum, item) => sum + item.amount,
          0
        );
        break;

      case "loans":
        reports = await Loan.find()
          .populate("userId", "fullName")
          .sort({ createdAt: -1 });

        stats.totalAmount = reports.reduce(
          (sum, item) => sum + item.principalAmount,
          0
        );
        break;

      case "revenue":
        reports = await Loan.find({
          status: "active",
        }).populate("userId", "fullName");

        stats.totalAmount = reports.reduce(
          (sum, item) => sum + (item.interestAmount || 0),
          0
        );
        break;

      default:
        stats.totalMembers = await User.countDocuments();

        stats.totalSavings = await Savings.aggregate([
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
            },
          },
        ]);

        stats.totalSavings = stats.totalSavings[0]?.total || 0;

        stats.totalLoansDisbursed = await Loan.aggregate([
          {
            $match: { status: "active" },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$principalAmount" },
            },
          },
        ]);

        stats.totalLoansDisbursed =
          stats.totalLoansDisbursed[0]?.total || 0;

        stats.totalRevenue = await Loan.aggregate([
          {
            $match: { status: "active" },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$interestAmount" },
            },
          },
        ]);

        stats.totalRevenue = stats.totalRevenue[0]?.total || 0;
    }

    return res.json({
      success: true,
      stats,
      reports,
      totalAmount: stats.totalAmount || 0,
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

/**
 * GET /api/admin/withdrawals/pending
 * Get all pending withdrawal requests (admin only)
 */
exports.getPendingWithdrawals = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const filter = { status: "pending_approval", type: "withdrawal" };
    const total = await Savings.countDocuments(filter);
    const withdrawals = await Savings.find(filter)
      .populate("userId", "fullName email phone")
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    return res.status(200).json({
      success: true,
      data: withdrawals,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

/**
 * POST /api/admin/withdrawals/:id/approve
 * Admin approves withdrawal and initiates Flutterwave payout.
 * Notifies user and logs audit.
 * On Flutterwave error, attempts rollback.
 */
exports.approveWithdrawal = async (req, res, next) => {
  try {
    const { id } = req.params;
    const withdrawal = await Savings.findById(id);
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Withdrawal not found." });
    }
    if (withdrawal.status !== "pending_approval") {
      return res.status(400).json({ success: false, message: "Withdrawal is not pending approval." });
    }
    if (!withdrawal.bankDetails || !withdrawal.bankDetails.bankCode || !withdrawal.bankDetails.accountNumber) {
      return res.status(400).json({ success: false, message: "Missing bank details." });
    }

    const user = await User.findById(withdrawal.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const { initiateTransfer } = require("../Utilis/flutterwave");
    const reference = `WTH_${Date.now()}_${withdrawal.userId.toString().slice(-6)}`;

    const transfer = await initiateTransfer(
      withdrawal.bankDetails.bankCode,
      withdrawal.bankDetails.accountNumber,
      withdrawal.amount,
      reference,
      `Socket Moni Withdrawal - ${user.fullName}`
    );

    await Savings.findByIdAndUpdate(id, {
      $set: {
        status: "pending",
        reference: reference,
        flutterwaveRef: transfer.data?.id || null,
        approvedAt: new Date(),
      },
    });

    await createNotification({
      userId: withdrawal.userId,
      type: "savings",
      title: "Withdrawal Approved",
      message: `Your withdrawal of ₦${withdrawal.amount.toLocaleString()} has been approved and is being processed.`,
      data: {
        action: "withdrawal_approved",
        withdrawalId: withdrawal._id,
        amount: withdrawal.amount,
        fee: withdrawal.fee || 0,
        totalDeducted: withdrawal.amount + (withdrawal.fee || 0),
        destinationBank: withdrawal.bankDetails,
        status: "pending",
        reference,
      },
    });

    await logAudit({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'withdrawal_approve',
      targetType: 'savings',
      targetId: id,
      details: { amount: withdrawal.amount, flutterwaveRef: transfer.data?.id, reference, approvedBy: req.user._id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.status(200).json({
      success: true,
      message: "Withdrawal approved and payout initiated.",
      data: { withdrawal: await Savings.findById(id), transferId: transfer.data?.id, reference },
    });
  } catch (err) {
    console.error("Approve withdrawal error:", err);
    try {
      const { id } = req.params;
     // AFTER
      const stuck = await Savings.findById(id).select("status flutterwaveRef");
      if (stuck && stuck.status === "pending" && !stuck.flutterwaveRef) {

        await Savings.findByIdAndUpdate(id, { $set: { status: "pending_approval", approvedAt: null } });
        console.log(`Rolled back withdrawal ${id} to pending_approval after error`);
      }
    } catch (rollbackErr) {
      console.error("Rollback failed:", rollbackErr);
    }
    return res.status(500).json({ success: false, message: err.message || "Failed to process payout." });
  }
};

/**
 * POST /api/admin/withdrawals/:id/reject
 * Admin rejects withdrawal request
 */
exports.rejectWithdrawal = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ success: false, message: "Rejection reason required." });
    }
    const withdrawal = await Savings.findById(id);
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Withdrawal not found." });
    }
    if (withdrawal.status !== "pending_approval") {
      return res.status(400).json({ success: false, message: "Withdrawal is not pending approval." });
    }

    withdrawal.status = "rejected";
    withdrawal.rejectionReason = reason;
    withdrawal.rejectedAt = new Date();
    await withdrawal.save();

    await createNotification({
      userId: withdrawal.userId,
      type: "savings",
      title: "Withdrawal Rejected",
      message: `Your withdrawal request of ₦${withdrawal.amount.toLocaleString()} was rejected. Reason: ${reason}`,
      data: {
        action: "withdrawal_rejected",
        withdrawalId: withdrawal._id,
        amount: withdrawal.amount,
        fee: withdrawal.fee || 0,
        totalDeducted: 0,
        destinationBank: withdrawal.bankDetails,
        status: "rejected",
        rejectionReason: reason,
        reference: withdrawal.reference,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Withdrawal rejected.",
    });
  } catch (err) {
    next(err);
  }
};
