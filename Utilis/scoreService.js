const { SocketScoreService } = require("../Services/SocketScoreService");

async function calculateScore(userId) {
  return await SocketScoreService.calculateScore(userId);
}

async function updateUserScore(userId, trigger = null) {
  return await SocketScoreService.updateUserScore(userId, trigger);
}

async function getScoreHistory(userId, limit = 12) {
  return await SocketScoreService.getScoreHistory(userId, limit);
}

async function getLatestBreakdown(userId) {
  const result = await SocketScoreService.calculateScore(userId);
  return result.components;
}

module.exports = {
  calculateScore,
  updateUserScore,
  getScoreHistory,
  getLatestBreakdown,
};