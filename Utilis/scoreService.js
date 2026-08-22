const User = require("../Models/UserModel");
const Savings = require("../Models/SavingsModel");
const Loan = require("../Models/LoanModel");
const ScoreHistory = require("../Models/ScoreHistory");

async function calculateScore(userId) {
    const user = await User.findById(userId);
    if (!user) throw new Error("User not found");

    const weights = typeof ScoreHistory.getScoringWeights === "function"
        ? ScoreHistory.getScoringWeights()
        : { savingsDisciplineWeight: 35, loanRepaymentWeight: 35, communityTrustWeight: 30 };

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    // 1. Savings Discipline (Scale 0 - 100 -> scaled by savingsDisciplineWeight)
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
    const savingsDisciplineScore = Math.round((averageCompletion / 100) * weights.savingsDisciplineWeight);

    // 2. Loan Repayment Behavior (Scale 0 - 100 -> scaled by loanRepaymentWeight)
    let loanRepaymentRaw = 70; // Default neutral for new borrowers
    const loans = await Loan.find({ userId: userId });
    if (loans.length > 0) {
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
            } else if (loan.status.includes("defaulted") || loan.status.includes("restricted")) {
                defaulted++;
            }
        });
        const base = (completedOnTime * 30) + (completedLate * 15);
        const penalty = defaulted * 40;
        loanRepaymentRaw = Math.max(0, Math.min(100, 70 + base - penalty));
    }
    const loanRepaymentScore = Math.round((loanRepaymentRaw / 100) * weights.loanRepaymentWeight);

    // 3. Community Trust (Scale 0 - 100 -> scaled by communityTrustWeight, based on referrals and complaint logs)
    const referralCount = await User.countDocuments({ referredBy: userId });
    const complaints = await require("../Models/ComplaintModel").find({ userId: userId, status: "resolved" });
    const trustBase = Math.min(80, 50 + (referralCount * 10)) - (complaints.length * 5);
    const communityTrustRaw = Math.max(0, Math.min(100, trustBase));
    const communityTrustScore = Math.round((communityTrustRaw / 100) * weights.communityTrustWeight);

    const breakdown = {
        savingsConsistency: savingsDisciplineScore,
        savingsGrowth: Math.round(savingsDisciplineScore * 0.4),
        loanRepayment: loanRepaymentScore,
        withdrawalBehaviour: Math.round(weights.savingsDisciplineWeight * 0.3),
        profileCompletion: 5,
        communityTrust: communityTrustScore,
    };

    const currentMonthPerformance = savingsDisciplineScore + loanRepaymentScore + communityTrustScore;

    // CGPA Style Cumulative Aggregate:
    // Existing score carries 85% weight, current monthly performance adds 15% delta
    const currentSocketScore = user.socketScore > 0 ? user.socketScore : 50;
    const overallScore = Math.min(100, Math.max(0, Math.round((currentSocketScore * 0.85) + (currentMonthPerformance * 0.15))));

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