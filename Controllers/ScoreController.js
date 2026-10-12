const { SocketScoreService } = require("../Services/SocketScoreService");

exports.getMyScore = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const scoreData = await SocketScoreService.calculateScore(userId);

    return res.status(200).json({
      success: true,
      data: {
        overallScore: scoreData.overallScore,
        components: scoreData.components,
        configurationVersion: scoreData.configurationVersion,
        calculatedAt: scoreData.calculatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.getScoreHistory = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const months = parseInt(req.query.months, 10) || 12;
    const history = await SocketScoreService.getScoreHistory(userId, months);

    return res.status(200).json({
      success: true,
      data: history,
    });
  } catch (err) {
    next(err);
  }
};

exports.getBreakdown = async (req, res, next) => {
  return exports.getMyScore(req, res, next);
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