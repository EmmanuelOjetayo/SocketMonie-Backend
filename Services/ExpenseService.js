const mongoose = require("mongoose");
const { ExpenseRepository } = require("../Repositories/ExpenseRepository");
const { FinancialLedgerService } = require("./FinancialLedgerService");
const { CapitalService } = require("./CapitalService");
const AppError = require("../Utilis/AppError");

const create = async ({ title, amount, category, description, reference, expenseDate, createdBy }) => {
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new AppError("Expense amount must be positive.", 400);
  const session = await mongoose.startSession();
  let expense;
  try {
    await session.withTransaction(async () => {
      expense = await ExpenseRepository.create({ title, amount: Number(amount), category, description, reference, expenseDate, createdBy }, session);
      // Deduct from capital
      await CapitalService.deductCapital({
        amount: Number(amount),
        source: "expense",
        description: description || title,
        adminId: createdBy,
        referenceId: expense._id,
        referenceType: "expense",
      });
      await FinancialLedgerService.recordEntry({
        entryType: "outflow",
        accountCategory: "operating_expense",
        activityType: "operating_expense",
        amount: Number(amount),
        reference,
        relatedId: expense._id,
        relatedModel: "Expenses",
        notes: description || title,
        session,
      });
    });
  } finally { await session.endSession(); }
  return expense;
};

const list = async ({ status, category, page = 1, limit = 20 }) => {
  const filter = {};
  if (status) filter.status = status;
  if (category) filter.category = category;
  const [total, expenses, totals] = await Promise.all([
    ExpenseRepository.count(filter),
    ExpenseRepository.find(filter, (page - 1) * limit, limit),
    ExpenseRepository.aggregateTotals(filter),
  ]);
  return { expenses, totals, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } };
};

const reverse = async ({ expenseId, adminId, reason }) => {
  const session = await mongoose.startSession();
  let expense;
  try {
    await session.withTransaction(async () => {
      expense = await ExpenseRepository.findById(expenseId, session);
      if (!expense) throw new AppError("Expense not found.", 404);
      if (expense.status !== "active") throw new AppError("Only active expenses can be reversed.", 400);
      expense.status = "reversed";
      expense.reversedBy = adminId;
      expense.reversalReason = reason;
      expense.reversedAt = new Date();
      await ExpenseRepository.save(expense, session);
      await FinancialLedgerService.recordEntry({
        entryType: "inflow",
        accountCategory: "operating_expense",
        activityType: "reversal_adjustment",
        amount: expense.amount,
        reference: `${expense.reference}:reversal`,
        relatedId: expense._id,
        relatedModel: "Expenses",
        notes: `Reversal of expense ${expense.reference}: ${reason}`,
        session,
      });
    });
  } finally { await session.endSession(); }
  return expense;
};

module.exports = { ExpenseService: { create, list, reverse } };