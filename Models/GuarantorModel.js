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
    },
    guarantorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      default: null, // Populated if the guarantor is an existing cooperative member
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

    // --- NEW: GUARANTOR VERIFICATION DETAILS ---
    address: { type: String, default: null },
    occupation: { type: String, default: null },
    employerName: { type: String, default: null },
    idType: {
      type: String,
      enum: ["nin", "drivers_license", "international_passport", "voters_card", "other"],
      default: null,
    },
    idNumber: { type: String, default: null },

    // --- NEW: DOCUMENT & CREDENTIAL URLS FOR SUPER ADMIN VIEWING ---
    idCardUrl: { type: String, default: null }, // Link to uploaded ID proof
    proofOfAddressUrl: { type: String, default: null }, // Utility bill / bank statement
    signatureUrl: { type: String, default: null }, // Digital signature / signed guarantee form

    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "expired"],
      default: "pending",
    },
    verificationToken: {
      type: String,
      required: true,
      unique: true,
    },
    tokenExpiresAt: {
      type: Date,
      required: true,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    releasedAt: {
  type: Date,
  default: null,
},
approvedLoanAt: {
  type: Date,
  default: null,
},
isReleased: {
  type: Boolean,
  default: false,
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