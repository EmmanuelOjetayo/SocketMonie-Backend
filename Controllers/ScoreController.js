const { SocketScoreService } = require("../Services/SocketScoreService");

exports.getMyScore = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const scoreData = await SocketScoreService.calculateScore(userId);
    return res.status(200).json({
      success: true,
      data: {
        overallScore: scoreData.overallScore,
        monthlyScore: scoreData.monthlyScore,
        cumulativeScore: scoreData.cumulativeScore,
        components: scoreData.components,
        configurationVersion: scoreData.configurationVersion,
        calculatedAt: scoreData.calculatedAt,
        period: scoreData.period,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.getScoreSummary = async (req, res, next) => {
  try {
    const summary = await SocketScoreService.getScoreSummary(req.user._id);
    return res.status(200).json({ success: true, data: summary });
  } catch (err) {
    next(err);
  }
};

exports.getScoreHistory = async (req, res, next) => {
  try {
    const months = parseInt(req.query.months, 10) || 12;
    const history = await SocketScoreService.getMonthlyHistory(req.user._id, months);
    return res.status(200).json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
};

exports.getMonthlyHistory = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 24;
    const history = await SocketScoreService.getMonthlyHistory(req.user._id, limit);
    return res.status(200).json({ success: true, data: history });
  } catch (err) {
    next(err);
  }
};

exports.getTrend = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 24;
    const trend = await SocketScoreService.getTrend(req.user._id, limit);
    return res.status(200).json({ success: true, data: trend });
  } catch (err) {
    next(err);
  }
};

exports.getExplanation = async (req, res, next) => {
  try {
    const explanation = await SocketScoreService.getExplanation();
    return res.status(200).json({ success: true, data: explanation });
  } catch (err) {
    next(err);
  }
};

exports.getBreakdown = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const scoreData = await SocketScoreService.calculateScore(userId);
    return res.status(200).json({
      success: true,
      data: {
        monthlyScore: scoreData.monthlyScore,
        cumulativeScore: scoreData.cumulativeScore,
        components: scoreData.components,
        configurationVersion: scoreData.configurationVersion,
        calculatedAt: scoreData.calculatedAt,
        period: scoreData.period,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.finalizeMonthly = async (req, res, next) => {
  try {
    const { year, month } = req.body || {};
    const record = await SocketScoreService.finalizeMonthlyScore(req.user._id, {
      year, month, force: true, trigger: "member_finalize",
    });
    return res.status(200).json({
      success: true,
      message: "Monthly SocketScore finalized successfully.",
      data: {
        monthlyScore: record.monthlyScore,
        cumulativeScore: record.cumulativeScore,
        period: record.period,
        status: record.calculationStatus,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.recalculateForAdmin = async (req, res, next) => {
  try {
    const userId = req.params.userId || req.body?.userId || req.user._id;
    const { year, month, force = true, reason } = req.body || {};
    const record = await SocketScoreService.finalizeMonthlyScore(userId, {
      year, month, force, trigger: "admin_recalculate",
      recalculatedBy: req.user._id, recalculatedReason: reason || "admin recalculation",
    });
    return res.status(200).json({ success: true, message: "Score recalculated.", data: record });
  } catch (err) {
    next(err);
  }
};

exports.getActiveConfig = async (req, res, next) => {
  try {
    const config = await SocketScoreService.getActiveConfig();
    return res.status(200).json({ success: true, data: config });
  } catch (err) {
    next(err);
  }
};

exports.updateScoringConfig = async (req, res, next) => {
  try {
    const { components, changeNotes } = req.body;
    const newConfig = await SocketScoreService.updateScoringConfig(components, changeNotes, req.user._id);
    return res.status(200).json({
      success: true,
      message: `Scoring configuration updated to Version ${newConfig.version}.`,
      data: newConfig,
    });
  } catch (err) {
    next(err);
  }
};

exports.getConfigHistory = async (req, res, next) => {
  try {
    const configs = await SocketScoreService.getAllConfigs();
    return res.status(200).json({ success: true, data: configs });
  } catch (err) {
    next(err);
  }
};
