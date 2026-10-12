const mongoose = require("mongoose");

const ReferralSchema = new mongoose.Schema(
  {
    referrerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    referredUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
      unique: true,
      index: true,
    },
    referralCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["registered", "verified", "qualified", "rewarded"],
      default: "registered",
      index: true,
    },
    qualificationEvent: {
      type: String,
      enum: ["membership_fee_paid", "first_deposit", "kyc_approved", "none"],
      default: "membership_fee_paid",
    },
    qualifiedAt: {
      type: Date,
      default: null,
    },
    referrerReward: {
      type: Number,
      default: 500, // ₦500 or points
    },
    referredUserReward: {
      type: Number,
      default: 0,
    },
    rewardStatus: {
      type: String,
      enum: ["unearned", "pending_payout", "rewarded", "forfeited"],
      default: "unearned",
      index: true,
    },
    rewardedAt: {
      type: Date,
      default: null,
    },
    rewardTransactionRef: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Referrals", ReferralSchema);
