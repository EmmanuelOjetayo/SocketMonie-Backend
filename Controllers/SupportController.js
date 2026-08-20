const Complaint = require("../Models/ComplaintModel");

exports.getTickets = async (req, res, next) => {
  try {
    const { status = "", page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const total = await Complaint.countDocuments(filter);
    const tickets = await Complaint.find(filter)
      .populate("userId", "fullName email phone")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    return res.status(200).json({ success: true, data: tickets, total, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
};

exports.updateTicketStatus = async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const { status } = req.body;
    if (!["pending", "resolved", "rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status." });
    }
    const ticket = await Complaint.findOne({ ticketId });
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found." });
    ticket.status = status;
    if (status === "resolved") ticket.resolvedAt = new Date();
    await ticket.save();
    return res.status(200).json({ success: true, message: "Ticket status updated.", ticket });
  } catch (err) { next(err); }
};

exports.getReferrals = async (req, res, next) => {
  try {
    const { status = "", page = 1, limit = 20 } = req.query;
    // For now, just return some users with referral codes
    const users = await User.find({ referralCode: { $exists: true } })
      .select("fullName email referralCode createdAt")
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await User.countDocuments({ referralCode: { $exists: true } });
    return res.status(200).json({ success: true, data: users, total, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
};