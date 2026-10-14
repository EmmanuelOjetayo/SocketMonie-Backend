const Complaint = require("../Models/ComplaintModel");
const { createNotification } = require("../Utilis/notificationHelper");

exports.getMyComplaints = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const complaints = await Complaint.find({ userId }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, items: complaints });
  } catch (err) { next(err); }
};

exports.submitComplaint = async (req, res) => {
  try {
    const { subject, message, category } = req.body;
    if (!subject || !message) {
      return res.status(400).json({ success: false, message: "Subject and message are required." });
    }
    // Generate ticketId before create: Mongoose validates required fields
    // before the pre('save') hook runs, so the hook alone would fail.
    const ticketId = `SMT${Math.floor(Math.random() * 1000000)
      .toString()
      .padStart(6, "0")}`;
    const complaint = await Complaint.create({
      userId: req.user._id,
      subject,
      message,
      category: category || "general",
      status: "pending",
      ticketId,
    });
    await createNotification({
      userId: req.user._id,
      type: "system",
      title: "Complaint Submitted",
      message: `Your complaint "${subject}" has been received. Ticket #${ticketId}`,
    });
    return res.status(201).json({ success: true, message: "Complaint submitted successfully.", ticketId, complaint });
  } catch (err) {
    console.error("❌ submitComplaint error:", err.message);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};