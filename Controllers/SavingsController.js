const { SavingsService } = require("../Services/SavingsService");

const getSavingsSummary = async (req, res, next) => {
  try {
    const summary = await SavingsService.getSavingsSummary(req.user._id);
    return res.status(200).json({
      success: true,
      summary,
    });
  } catch (error) {
    next(error);
  }
};

const getMonthlySavingsReport = async (req, res, next) => {
  try {
    const report = await SavingsService.getMonthlySavingsReport(req.user._id);
    return res.status(200).json({
      success: true,
      data: report,
    });
  } catch (error) {
    next(error);
  }
};

const getSavingsHistory = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const result = await SavingsService.getSavingsHistory(req.user._id, page, limit);
    return res.status(200).json({
      success: true,
      data: result.history,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};

const withdrawFromSavings = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { amount, method, bankDetails, pin } = req.body;
    const data = await SavingsService.withdrawFromSavings({ userId, amount, method, bankDetails, pin });
    return res.status(200).json({
      success: true,
      message: "Withdrawal processed successfully.",
      data,
    });
  } catch (error) {
    next(error);
  }
};

const requestWithdrawal = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { amount, accountNumber, accountName, bankName, pin } = req.body;
    const data = await SavingsService.requestWithdrawal({
      userId,
      amount,
      accountNumber,
      accountName,
      bankName,
      pin,
    });
    return res.status(201).json({
      success: true,
      message: "Withdrawal request submitted for approval.",
      data,
    });
  } catch (error) {
    next(error);
  }
};

const initializeMembershipFee = async (req, res, next) => {
  try {
    const data = await SavingsService.initializeMembershipFee(req.user._id);
    return res.status(200).json({
      success: true,
      message: "Membership fee payment initialized.",
      data,
    });
  } catch (error) {
    next(error);
  }
};

const verifyMembershipFee = async (req, res, next) => {
  try {
    const { reference, tx_ref, transaction_id, transactionId } = req.body;
    const result = await SavingsService.verifyMembershipFee({
      userId: req.user._id,
      reference,
      tx_ref,
      transaction_id,
      transactionId,
    });

    if (result.alreadyPaid) {
      return res.status(200).json({
        success: true,
        message: "Membership fee already recorded as paid.",
        data: { membershipFeePaid: true },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Membership fee verified successfully! Cooperative features unlocked.",
      data: {
        membershipFeePaid: true,
        membershipFeePaidAt: result.membershipFeePaidAt,
      },
    });
  } catch (error) {
    if (error.reasons) {
      return res.status(400).json({
        success: false,
        message: error.message,
        reasons: error.reasons,
      });
    }
    next(error);
  }
};

const updateTierCommitment = async (req, res, next) => {
  try {
    const { newTier, newCommitment } = req.body;
    const result = await SavingsService.updateTierCommitment({
      userId: req.user._id,
      newTier,
      newCommitment,
    });

    return res.status(200).json({
      success: true,
      message: `Successfully upgraded to ${result.formattedTier} Tier! Your new monthly target is ₦${Number(result.monthlySavingsCommitment).toLocaleString()}.`,
      data: {
        tier: result.tier,
        monthlySavingsCommitment: result.monthlySavingsCommitment,
      },
    });
  } catch (error) {
    if (error.reasons) {
      return res.status(400).json({
        success: false,
        message: error.message,
        reasons: error.reasons,
      });
    }
    next(error);
  }
};

module.exports = {
  getSavingsSummary,
  getMonthlySavingsReport,
  getSavingsHistory,
  withdrawFromSavings,
  requestWithdrawal,
  initializeMembershipFee,
  verifyMembershipFee,
  updateTierCommitment,
};