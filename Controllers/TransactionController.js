// TransactionService exports its functions directly (flat module), so the
// whole module is the service object — no `{ TransactionService }` named export.
const TransactionService = require("../Services/TransactionService");
const AppError = require("../Utilis/AppError");

/**
 * GET /api/transactions
 * Query: ?month=&year=&type=all|savings|minute|membership|loan&search=&page=&limit=50
 *
 * Unified transaction history across savings, minutes, membership and loan
 * payments. Merges the dedicated transaction models with legacy records so
 * nothing disappears for pre-existing payments.
 */
exports.getTransactions = async (req, res, next) => {
  try {
    const { month, year, type, search, page, limit } = req.query;

    const result = await TransactionService.list({
      userId: req.user._id,
      month,
      year,
      type,
      search,
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

/**
 * GET /api/transactions/:id
 *
 * A single transaction owned by the requesting member. Backs the
 * transaction-detail screen so a deep link or a page refresh resolves the
 * record from the backend instead of trusting navigation state.
 */
exports.getTransaction = async (req, res, next) => {
  try {
    const transaction = await TransactionService.getOne(req.user._id, req.params.id);

    if (!transaction) {
      return next(new AppError("Transaction not found for this account.", 404));
    }

    return res.status(200).json({
      success: true,
      transaction,
    });
  } catch (error) {
    next(error);
  }
};
