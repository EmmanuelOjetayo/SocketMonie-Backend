const mongoose = require("mongoose");

const GuarantorSchema = new mongoose.Schema(
  {
    loanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Loans",
      required: true,
      index: true,
    },
    applicantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    guarantorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      default: null,
      index: true,
    },
    guarantorName: {
      type: String,
      required: true,
      trim: true,
    },
    guarantorEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    guarantorPhone: {
      type: String,
      required: true,
      trim: true,
    },
    relationship: {
      type: String,
      required: true,
    },
    guaranteedAmount: {
      type: Number,
      required: true,
    },
    remainingGuaranteedBalance: {
      type: Number,
      required: true,
    },
    address: { type: String, default: null },
    occupation: { type: String, default: null },
    employerName: { type: String, default: null },
    idType: {
      type: String,
      enum: ["nin", "drivers_license", "international_passport", "voters_card", "other"],
      default: null,
    },
    idNumber: { type: String, default: null },
    idCardUrl: { type: String, default: null },
    proofOfAddressUrl: { type: String, default: null },
    signatureUrl: { type: String, default: null },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "expired", "active", "released"],
      default: "pending",
      index: true,
    },
    verificationToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    tokenExpiresAt: {
      type: Date,
      required: true,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    rejectedAt: {
      type: Date,
      default: null,
    },
    releasedAt: {
      type: Date,
      default: null,
    },
    isReleased: {
      type: Boolean,
      default: false,
    },
    isReplaced: {
      type: Boolean,
      default: false,
    },
    replacementFor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guarantors",
      default: null,
    },
    replacedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Guarantors",
      default: null,
    },
    rejectionReason: {
      type: String,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Guarantors", GuarantorSchema);