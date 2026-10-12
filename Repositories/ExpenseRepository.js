const Expense = require("../Models/ExpenseModel");

const ExpenseRepository = {
  create: (data, session) => Expense.create([data], { session }).then(([expense]) => expense),
  findById: (id, session = null) => {
    const query = Expense.findById(id);
    if (session) query.session(session);
    return query;
  },
  find: (filter, skip, limit) => Expense.find(filter).sort({ expenseDate: -1 }).skip(skip).limit(limit).populate("createdBy reversedBy", "fullName email"),
  count: (filter) => Expense.countDocuments(filter),
  save: (expense, session) => expense.save({ session }),
  aggregateTotals: (filter) => Expense.aggregate([
    { $match: filter },
    { $group: { _id: "$status", total: { $sum: "$amount" }, count: { $sum: 1 } } },
  ]),
};

module.exports = { ExpenseRepository };