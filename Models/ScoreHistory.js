const mongoose = require("mongoose");

const ScoreHistorySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Users",
        required: true,
        index: true,
    },
    overallScore: { type: Number, required: true },
    breakdown: {
        savingsConsistency: { type: Number, default: 0 },
        savingsGrowth: { type: Number, default: 0 },
        loanRepayment: { type: Number, default: 0 },
        withdrawalBehaviour: { type: Number, default: 0 },
        profileCompletion: { type: Number, default: 0 },
        communityTrust: { type: Number, default: 0 },
    },
    components: [{
        code: { type: String, required: true },
        name: { type: String, required: true },
        rawScore: { type: Number, min: 0, max: 100, required: true },
        weight: { type: Number, min: 0, max: 100, required: true },
        contribution: { type: Number, min: 0, max: 100, required: true },
        status: { type: String, required: true },
    }],
    configurationVersion: { type: Number, required: true },
    calculatedAt: { type: Date, required: true, default: Date.now },
    period: {
        year: { type: Number, required: true },
        month: { type: Number, required: true },
    },
    trigger: { type: String, default: null },
}, { timestamps: true });

ScoreHistorySchema.statics.getScoringWeights = function () {
    return {
        savingsDisciplineWeight: 35,
        loanRepaymentWeight: 35,
        communityTrustWeight: 30,
    };
};

module.exports = mongoose.model("ScoreHistory", ScoreHistorySchema);