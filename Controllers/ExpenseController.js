const { AdminActivityService } = require("../Services/AdminActivityService");
const { ExpenseService } = require("../Services/ExpenseService");

exports.create = async (req, res, next) => {
  try {
    const expense = await ExpenseService.create({ ...req.body, createdBy: req.user._id });
    // Log admin activity
    await AdminActivityService.logExpenseCreate({
      adminId: req.user._id,
      expenseId: expense._id,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent") || "",
    });
    return res.status(201).json({ success: true, data: expense });
  } catch (error) { next(error); }
};

exports.list = async (req, res, next) => {
  try {
    const result = await ExpenseService.list({
      status: req.query.status,
      category: req.query.category,
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 20),
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) { next(error); }
};

exports.reverse = async (req, res, next) => {
  try {
    const expense = await ExpenseService.reverse({
      expenseId: req.params.id,
      adminId: req.user._id,
      reason: req.body.reason,
    });
    // Log admin activity
    await AdminActivityService.logExpenseReverse({
      adminId: req.user._id,
      expenseId: req.params.id,
      reason: req.body.reason,
      ipAddress: req.ip,
      userAgent: req.get("User-Agent") || "",
    });
    return res.status(200).json({ success: true, data: expense });
  } catch (error) { next(error); }
};