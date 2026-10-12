const { LoanService, processLoanRepayment } = require("../Services/LoanService");

exports.checkEligibility = async (req, res, next) => {
  try {
    const loanType = req.query.loanType || "cooperative";
    const eligibility = await LoanService.getEligibility(req.user._id, loanType);
    return res.status(200).json({
      success: true,
      eligibility,
    });
  } catch (err) {
    next(err);
  }
};

exports.getActiveLoan = async (req, res, next) => {
  try {
    const activeLoan = await LoanService.getActiveLoan(req.user._id);
    return res.status(200).json({
      success: true,
      loan: activeLoan || null,
    });
  } catch (err) {
    next(err);
  }
};

exports.getLoanById = async (req, res, next) => {
  try {
    const loan = await LoanService.getById(req.params.loanId, req.user._id, req.user.role);
    return res.status(200).json({
      success: true,
      loan,
    });
  } catch (err) {
    next(err);
  }
};

exports.getLoanHistory = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    const result = await LoanService.getHistory(req.user._id, status, parsedPage, parsedLimit);

    return res.status(200).json({
      success: true,
      data: result.loans,
      pagination: result.pagination,
      stats: result.stats,
    });
  } catch (err) {
    next(err);
  }
};

exports.getRepaymentSchedule = async (req, res, next) => {
  try {
    const schedule = await LoanService.getSchedule(req.params.loanId, req.user._id, req.user.role);
    return res.status(200).json({
      success: true,
      schedule: schedule.schedule,
      nextDue: schedule.nextDue,
    });
  } catch (err) {
    next(err);
  }
};

exports.applyForLoan = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const {
      amount,
      durationMonths,
      loanType,
      disbursementMethod,
      purpose,
      guarantorReferralCodes,
    } = req.body;

    const newLoan = await LoanService.applyForLoan({
      userId,
      amount,
      durationMonths,
      loanType,
      disbursementMethod,
      purpose,
      guarantorReferralCodes,
    });

    return res.status(201).json({
      success: true,
      message: "Loan application submitted. Awaiting all four guarantor approvals.",
      loan: newLoan,
    });
  } catch (err) {
    next(err);
  }
};

exports.replaceGuarantor = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { loanId } = req.params;
    const { oldGuarantorUserId, newGuarantorReferralCode, reason } = req.body;

    const updatedLoan = await LoanService.replaceGuarantor({
      userId,
      loanId,
      oldGuarantorUserId,
      newGuarantorReferralCode,
      reason,
    });

    return res.status(200).json({
      success: true,
      message: "Replacement guarantor assigned successfully. Guarantee invitation sent.",
      loan: updatedLoan,
    });
  } catch (err) {
    next(err);
  }
};

exports.approveAndDisburseLoan = async (req, res, next) => {
  try {
    if (!["super_admin", "finance_manager"].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized. Only authorized finance staff can approve loans.",
      });
    }

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

exports.initializeLoanRepayment = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { loanId, paymentAmount } = req.body;

    const data = await LoanService.initializeLoanRepayment({
      userId,
      userEmail: req.user.email,
      userName: req.user.fullName,
      userPhone: req.user.phone,
      loanId,
      paymentAmount,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    next(err);
  }
};

exports.verifyLoanRepayment = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { loanId, reference, tx_ref, transactionId, transaction_id } = req.body;

    const updatedLoan = await LoanService.verifyLoanRepayment({
      userId,
      loanId,
      reference,
      tx_ref,
      transactionId,
      transaction_id,
    });

    return res.status(200).json({
      success: true,
      message: "Loan repayment verified successfully.",
      loan: updatedLoan,
    });
  } catch (err) {
    next(err);
  }
};

exports.triggerLoanDefaulterCheck = async (req, res, next) => {
  try {
    if (!["super_admin", "finance_manager"].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Unauthorized." });
    }

    const summary = await LoanService.triggerLoanDefaulterCheck();

    return res.status(200).json({
      success: true,
      message: "Loan defaulter escalation process executed successfully.",
      data: summary,
    });
  } catch (err) {
    next(err);
  }
};

exports.processLoanRepayment = processLoanRepayment;