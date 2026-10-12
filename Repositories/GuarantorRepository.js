const Savings = require("../Models/SavingsModel");
const Guarantor = require("../Models/GuarantorModel");
const Loan = require("../Models/LoanModel");
const User = require("../Models/UserModel");

const GuarantorRepository = {
  findUserByReferralCode: (referralCode) =>
    User.findOne({ referralCode }).select("_id fullName email phone referralCode tier profileImage"),

  findCompletedSavings: (userId) => Savings.find({ userId, status: "completed" }),

  findLoan: (loanId, session = null) => {
    const query = Loan.findById(loanId);
    if (session) query.session(session);
    return query;
  },

  findByLoan: (loanId) => Guarantor.findOne({ loanId }),

  findByToken: (token) =>
    Guarantor.findOne({ verificationToken: token })
      .populate("loanId", "loanNumber principalAmount interestAmount interestRate totalRepayable durationMonths purpose loanType status createdAt")
      .populate("applicantId", "fullName email phone referralCode profileImage kycStatus createdAt"),

  findRawByToken: (token, session = null) => {
    const query = Guarantor.findOne({ verificationToken: token });
    if (session) query.session(session);
    return query;
  },

  findPendingForUser: (userId) =>
    Guarantor.find({ guarantorUserId: userId, status: "pending" })
      .populate("loanId", "loanNumber principalAmount interestAmount interestRate totalRepayable durationMonths purpose loanType status createdAt")
      .populate("applicantId", "fullName email phone referralCode profileImage kycStatus createdAt")
      .lean(),

  findSummaryGuarantees: (userId) =>
    Guarantor.find({ guarantorUserId: userId, status: { $in: ["accepted", "active"] } }),

  findUserScore: (userId) => User.findById(userId).select("score socketScore"),

  saveGuarantor: (guarantor, session = null) => {
    if (session) return guarantor.save({ session });
    return guarantor.save();
  },

  saveLoan: (loan, session = null) => {
    if (session) return loan.save({ session });
    return loan.save();
  },
};

module.exports = { GuarantorRepository };