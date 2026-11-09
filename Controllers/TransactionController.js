const { TransactionService } = require("../Services/TransactionService");

/**
 * GET /api/transactions
 * Query: ?month=&year=&type=all|savings|minute|membership|loan&page=&limit=50
 *
 * Unified transaction history across savings, minutes, membership and loan
 * payments. Merges the dedicated transaction models with legacy records so
 * nothing disappears for pre-existing payments.
 */
exports.getTransactions = async (req, res, next) => {
  try {
    const { month, year, type, page, limit } = req.query;

    const result = await TransactionService.list({
      userId: req.user._id,
      month,
      year,
      type,
      page,
      limit,
    });

    return res.status(200).json({
      success: true,
      transactions: result.transactions,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};
