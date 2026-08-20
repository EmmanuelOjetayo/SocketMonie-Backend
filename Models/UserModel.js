const mongoose = require("mongoose");

const UserSchema = mongoose.Schema({
    fullName: String,
    email: {
        required: true,
        unique: true,
        type: String
    },
    phone: String,
    password: {
        type: String,
        required: true
    },
    // AFTER
role: {
    type: String,
    enum: ["member", "finance_manager", "customer_support", "super_admin"],
    default: "member"
},
    // User's own unique referral code to invite others
    referralCode: {
        type: String,
        unique: true,
        sparse: true
    },
    // Reference to the user who referred this member (PRD Section 4)
    referredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Users",
        default: null
    },
    // Phase 1 Monetization & Paywall Fields
    membershipFeePaid: {
        type: Boolean,
        default: false
    },
    membershipFeeTxRef: {
        type: String,
        default: null
    },
    membershipFeePaidAt: {
        type: Date,
        default: null
    },
    isVerified: {
        default: false,
        type: Boolean
    },
    otp: String,
    otpExpiresAt: Date,
    resetPasswordOTP: String,
    resetPasswordOTPExpiresAt: Date,
    status: {
        type: String,
        enum: ["completed", "pending", "failed", "suspended"],
        default: "pending",
    },
    socketScore: {
        type: Number,
        default: 0,
    },
    socketScoreBreakdown: {
        savingsConsistency: { type: Number, default: 0 },
        savingsGrowth: { type: Number, default: 0 },
        loanRepayment: { type: Number, default: 0 },
        withdrawalBehaviour: { type: Number, default: 0 },
        profileCompletion: { type: Number, default: 0 },
        communityTrust: { type: Number, default: 0 },
    },
    socketScoreHistory: [
        {
            total: Number,
            breakdown: {
                savingsConsistency: Number,
                savingsGrowth: Number,
                loanRepayment: Number,
                withdrawalBehaviour: Number,
                profileCompletion: Number,
                communityTrust: Number,
            },
            recordedAt: { type: Date, default: Date.now },
        },
    ],
    socketScoreUpdatedAt: { type: Date, default: null },

    tier: {
        type: String,
        enum: ["Bronze", "Silver", "Gold", "Platinum"],
        default: "Bronze",
    },
    monthlySavingsCommitment: { type: Number, default: 0 },

    // AFTER
    bankDetails: {
        accountNumber: { type: String, default: null },
        bankCode: { type: String, default: null },
        bankName: { type: String, default: null },
        accountName: { type: String, default: null },
        verified: { type: Boolean, default: false },
        verifiedAt: { type: Date, default: null },
    },
    bvn: { type: String, default: null },
    nin: { type: String, default: null },
    selfieUrl: { type: String, default: null },
    tierUpgradeRequest: {
        requestedTier: { type: String, enum: ["Bronze", "Silver", "Gold", "Platinum"], default: null },
        status: { type: String, enum: ["pending", "approved", "rejected"], default: null },
        submittedAt: { type: Date, default: null },
        reviewedAt: { type: Date, default: null },
        reviewerId: { type: mongoose.Schema.Types.ObjectId, ref: "Users", default: null },
        reason: { type: String, default: null },
    },

    communityTrustLog: [
        {
            reason: String,
            delta: Number,
            createdAt: { type: Date, default: Date.now },
        },
    ],
    dateOfBirth: { type: String },
    gender: { type: String, enum: ["male", "female"] },
    address: { type: String },
    stateOfOrigin: { type: String },
    occupation: { type: String },

    documentType: {
        type: String,
        enum: ['nin', 'voters_card', 'passport', 'drivers_license'],
        default: null,
    },
    documentUrl: {
        type: String,
        default: null,
    },
    kycStatus: {
        type: String,
        enum: ['unverified', 'pending_review', 'approved', 'rejected'],
        default: 'unverified',
    },
    kycRejectionReason: {
        type: String,
        default: null,
    },
    kycUploadedAt: {
        type: Date,
        default: null,
    },
    kycVerifiedAt: {
        type: Date,
        default: null,
    },

    transactionPin: {
        type: String,
        default: null,
    },
    
    isPinSet: {
        type: Boolean,
        default: false,
    },    
}, { timestamps: true });

module.exports = mongoose.model("Users", UserSchema);