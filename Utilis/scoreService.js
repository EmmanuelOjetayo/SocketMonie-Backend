const User = require("../Models/UserModel");
const Savings = require("../Models/SavingsModel");
const Loan = require("../Models/LoanModel");
const ScoreHistory = require("../Models/ScoreHistory");

async function calculateScore(userId) {
    const user = await User.findById(userId);
    if (!user) throw new Error("User not found");

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    let savingsConsistencyScore = 0;
    const monthlyCommitment = user.monthlySavingsCommitment || 5000;
    const deposits = await Savings.find({
        userId: userId,
        type: "deposit",
        status: "completed",
        createdAt: { $gte: sixMonthsAgo },
    });

    const monthMap = {};
    deposits.forEach(d => {
        const key = `${d.createdAt.getFullYear()}-${d.createdAt.getMonth()}`;
        monthMap[key] = (monthMap[key] || 0) + d.amount;
    });

    let totalCompletion = 0;
    let monthCount = 0;
    for (let i = 0; i < 6; i++) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const key = `${date.getFullYear()}-${date.getMonth()}`;
        const monthTotal = monthMap[key] || 0;
        const completion = Math.min(100, (monthTotal / monthlyCommitment) * 100);
        totalCompletion += completion;
        monthCount++;
    }
    const averageCompletion = monthCount > 0 ? totalCompletion / monthCount : 0;
    savingsConsistencyScore = Math.round((averageCompletion / 100) * 35);

    let savingsGrowthScore = 0;
    const months = Object.keys(monthMap).sort();
    if (months.length >= 2) {
        const firstMonth = months[0];
        const lastMonth = months[months.length - 1];
        const firstTotal = monthMap[firstMonth] || 0;
        const lastTotal = monthMap[lastMonth] || 0;
        if (lastTotal > firstTotal) savingsGrowthScore = 15;
        else if (lastTotal === firstTotal) savingsGrowthScore = 10;
        else savingsGrowthScore = 5;
    } else if (months.length === 1) {
        savingsGrowthScore = 10;
    } else {
        savingsGrowthScore = 0;
    }

    let loanRepaymentScore = 0;
    const loans = await Loan.find({ userId: userId });
    const totalLoans = loans.length;
    if (totalLoans > 0) {
        let completedOnTime = 0;
        let completedLate = 0;
        let defaulted = 0;
        loans.forEach(loan => {
            if (loan.status === "completed") {
                let onTime = true;
                (loan.installments || []).forEach(inst => {
                    if (inst.status === "paid" && inst.paidAt && inst.dueDate) {
                        if (new Date(inst.paidAt) > new Date(inst.dueDate)) onTime = false;
                    } else if (inst.status !== "paid") {
                        onTime = false;
                    }
                });
                if (onTime) completedOnTime++;
                else completedLate++;
            } else if (loan.status === "defaulted_60_days") {
                defaulted++;
            }
        });
        let baseScore = 0;
        if (completedOnTime > 0) {
            baseScore = Math.min(25, completedOnTime * 10);
        } else if (completedLate > 0) {
            baseScore = Math.min(15, completedLate * 5);
        }
        const defaultPenalty = Math.min(25, defaulted * 8);
        loanRepaymentScore = Math.max(0, baseScore - defaultPenalty);
    } else {
        loanRepaymentScore = 12;
    }

    let withdrawalBehaviourScore = 10;
    const withdrawals = await Savings.find({
        userId: userId,
        type: "withdrawal",
        status: "completed",
    });
    const totalWithdrawals = withdrawals.length;
    if (totalWithdrawals > 0) {
        const monthsWithWithdrawal = new Set();
        withdrawals.forEach(w => {
            monthsWithWithdrawal.add(`${w.createdAt.getFullYear()}-${w.createdAt.getMonth()}`);
        });
        const ratio = monthsWithWithdrawal.size / Math.max(1, months.length);
        if (ratio > 0.5) {
            withdrawalBehaviourScore = Math.max(2, 10 - (ratio * 8));
        } else if (ratio > 0.3) {
            withdrawalBehaviourScore = Math.max(5, 10 - (ratio * 5));
        } else {
            withdrawalBehaviourScore = 10;
        }
    }

    let profileCompletionScore = 0;
    const requiredFields = ['fullName', 'email', 'phone', 'dateOfBirth', 'gender', 'address', 'stateOfOrigin', 'occupation', 'isPinSet'];
    let completed = 0;
    requiredFields.forEach(field => {
        if (user[field] && user[field] !== null && user[field] !== '') completed++;
    });
    if (user.kycStatus === 'approved') completed += 2;
    if (user.bankDetails?.verified) completed += 1;
    if (user.nin) completed += 1;
    if (user.bvn) completed += 1;
    if (user.selfieUrl) completed += 1;
    const maxScore = requiredFields.length + 6;
    profileCompletionScore = Math.round((completed / maxScore) * 5);

    let communityTrustScore = 10;
    const complaints = await require("../Models/ComplaintModel").find({ userId: userId, status: "resolved" });
    if (complaints.length > 0) {
        communityTrustScore = Math.max(2, 10 - (complaints.length * 2));
    }

    const breakdown = {
        savingsConsistency: Math.round(savingsConsistencyScore),
        savingsGrowth: Math.round(savingsGrowthScore),
        loanRepayment: Math.round(loanRepaymentScore),
        withdrawalBehaviour: Math.round(withdrawalBehaviourScore),
        profileCompletion: Math.round(profileCompletionScore),
        communityTrust: Math.round(communityTrustScore),
    };
    const overallScore = Object.values(breakdown).reduce((a, b) => a + b, 0);
    return { breakdown, overallScore };
}

async function updateUserScore(userId, trigger = null) {
    const { breakdown, overallScore } = await calculateScore(userId);
    const user = await User.findByIdAndUpdate(userId, { socketScore: overallScore }, { new: true });
    const now = new Date();
    await ScoreHistory.create({
        userId,
        overallScore,
        breakdown,
        period: { year: now.getFullYear(), month: now.getMonth() + 1 },
        trigger,
    });
    return { user, breakdown, overallScore };
}

async function getScoreHistory(userId, limit = 12) {
    return await ScoreHistory.find({ userId })
        .sort({ 'period.year': -1, 'period.month': -1 })
        .limit(limit)
        .lean();
}

async function getLatestBreakdown(userId) {
    const history = await ScoreHistory.findOne({ userId })
        .sort({ 'period.year': -1, 'period.month': -1 })
        .lean();
    return history?.breakdown || null;
}

module.exports = { calculateScore, updateUserScore, getScoreHistory, getLatestBreakdown };