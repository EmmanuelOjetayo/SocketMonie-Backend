const mongoose = require("mongoose");

/**
 * Server-side document drafts (owner-approved decision #4).
 * One draft per user per kind; `updatedAt` (from timestamps) drives the
 * 30-day inactivity expiry evaluated in DraftService.
 */
const UserDraftSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Users",
            required: true,
            unique: true,
            index: true,
        },
        kind: {
            type: String,
            enum: ["loan_application", "onboarding"],
            default: "loan_application",
        },
        data: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("UserDraft", UserDraftSchema);
