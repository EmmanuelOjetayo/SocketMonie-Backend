const { Capital } = require("../Models/CapitalModel");
const AppError = require("../Utilis/AppError");

/**
 * Add capital to the cooperative capital pool
 * @param {Number} amount - Positive amount to add
 * @param {String} source - Source of capital (e.g., "interest_revenue", "capital_injection")
 * @param {String} description - Description of the capital movement
 * @param {String} adminId - Admin who performed the action
 * @param {String} referenceId - Related expense/loan ID
 * @param {String} referenceType - Type of reference (expense, loan, etc.)
 */
const addCapital = async ({ amount, source, description, adminId, referenceId = null, referenceType = "" }, session = null) => {
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new AppError("Capital amount must be positive.", 400);
  }

  // Capital movements are tracked in the Capital collection itself; the
  // financial ledger entry for the underlying event is written by the caller
  // (e.g. ExpenseService) so every financial event gets exactly one entry.
  if (session) {
    return await Capital.create([{ amount: Number(amount), source, description, adminId, referenceId, referenceType }], { session }).then((docs) => docs[0]);
  }
  const capital = await Capital.create({
    amount: Number(amount),
    source,
    description,
    adminId,
    referenceId,
    referenceType,
  });

  return capital;
};

/**
 * Deduct capital from the cooperative capital pool
 * @param {Number} amount - Positive amount to deduct
 * @param {String} source - Source of capital deduction (e.g., "expense", "loan_disbursement")
 * @param {String} description - Description of the capital movement
 * @param {String} adminId - Admin who performed the action
 * @param {String} referenceId - Related expense/loan ID
 * @param {String} referenceType - Type of reference
 */
const deductCapital = async ({ amount, source, description, adminId, referenceId = null, referenceType = "" }, session = null) => {
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new AppError("Capital amount must be positive.", 400);
  }

  // Movement log only — the caller owns the single financial-ledger entry
  // (writing one here double-counted outflows: `operating_expense` +
  // `expense_deduction` for the same expense).
  if (session) {
    return await Capital.create([{ amount: -Number(amount), source, description, adminId, referenceId, referenceType }], { session }).then((docs) => docs[0]);
  }
  const capital = await Capital.create({
    amount: -Number(amount), // Negative amount for deduction
    source,
    description,
    adminId,
    referenceId,
    referenceType,
  });

  return capital;
};

/**
 * Get capital history
 * @param {Object} filter - MongoDB filter options
 */
const getCapitalHistory = async (filter = {}) => {
  return await Capital.find(filter)
    .sort({ createdAt: -1 })
    .populate("adminId", "fullName email")
    .lean();
};

/**
 * Get current capital position
 */
const getCapitalPosition = async () => {
  const capitalRecords = await Capital.find().lean();
  
  let totalCapital = 0;
  const movements = [];
  
  capitalRecords.forEach(record => {
    const absAmount = Math.abs(record.amount);
    const isDeduction = record.amount < 0;
    
    movements.push({
      id: record._id,
      source: record.source,
      description: record.description,
      amount: record.amount,
      absAmount,
      isDeduction,
      admin: record.adminId ? record.adminId.fullName : "Unknown",
      createdAt: record.createdAt,
    });
    
    totalCapital += record.amount; // This will be negative for deductions
  });
  
  return {
    currentCapital: totalCapital,
    movements,
    totalInjected: movements.filter(m => m.amount > 0).reduce((sum, m) => sum + m.absAmount, 0),
    totalDeducted: movements.filter(m => m.amount < 0).reduce((sum, m) => sum + Math.abs(m.absAmount), 0),
  };
};

module.exports = {
  addCapital,
  deductCapital,
  getCapitalHistory,
  getCapitalPosition,
};