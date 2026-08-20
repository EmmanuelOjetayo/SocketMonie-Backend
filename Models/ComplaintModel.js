const mongoose = require("mongoose");

const ComplaintSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    category: {
      type: String,
      enum: ["general", "savings", "loan", "kyc", "referral", "other"],
      default: "general",
    },
    status: {
      type: String,
      enum: ["pending", "resolved", "rejected"],
      default: "pending",
    },
    ticketId: { type: String, unique: true, required: true },
    resolution: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ComplaintSchema.pre("save", function(next) {
  if (!this.ticketId) {
    const prefix = "SMT";
    const random = Math.floor(Math.random() * 1000000).toString().padStart(6, "0");
    this.ticketId = `${prefix}${random}`;
  }
  next();
});

module.exports = mongoose.model("Complaint", ComplaintSchema);