const Complaint = require("../Models/ComplaintModel");
const Referral = require("../Models/ReferralModel");

const REFERRAL_STATUSES = ["registered", "verified", "qualified", "rewarded"];

exports.getTickets = async (req, res, next) => {
  try {
    const { status = "", page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) {
      if (!["pending", "resolved", "rejected"].includes(status)) {
        return res.status(400).json({ success: false, message: "Invalid ticket status filter." });
      }
      filter.status = status;
    }
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const [total, resolvedThisMonth] = await Promise.all([
      Complaint.countDocuments(filter),
      Complaint.countDocuments({ status: "resolved", resolvedAt: { $gte: monthStart } }),
    ]);
    const tickets = await Complaint.find(filter)
      .populate("userId", "fullName email phone")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    return res.status(200).json({ success: true, data: tickets, total, resolvedThisMonth, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
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
    const filter = {};
    if (status === "pending") {
      // "Pending" verifications = referrals that have not reached the
      // qualified/rewarded states yet.
      filter.status = { $in: ["registered", "verified"] };
    } else if (REFERRAL_STATUSES.includes(status)) {
      filter.status = status;
    } else if (status) {
      return res.status(400).json({ success: false, message: "Invalid referral status filter." });
    }
    // Real referral model data (the Referrals collection), not a surrogate.
    const [total, referrals] = await Promise.all([
      Referral.countDocuments(filter),
      Referral.find(filter)
        .populate("referrerId", "fullName email referralCode")
        .populate("referredUserId", "fullName email createdAt")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit)),
    ]);
    return res.status(200).json({ success: true, data: referrals, total, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
};