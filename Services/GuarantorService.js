const mongoose = require("mongoose");
const { GuarantorRepository } = require("../Repositories/GuarantorRepository");
const { createNotification } = require("../Utilis/notificationHelper");
const AppError = require("../Utilis/AppError");

const getNetSavings = async (userId) => {
  const savings = await GuarantorRepository.findCompletedSavings(userId);
  return savings.reduce(
    (sum, item) => sum + (item.type === "withdrawal" ? -item.amount : item.type === "deposit" ? item.amount : 0),
    0
  );
};

const checkSavingsConsistency = async (userId) => {
  const savings = await GuarantorRepository.findCompletedSavings(userId);
  const monthly = {};
  savings
    .filter((item) => item.type === "deposit")
    .forEach((item) => {
      const date = new Date(item.createdAt);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      monthly[key] = (monthly[key] || 0) + item.amount;
    });
  const now = new Date();
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if ((monthly[key] || 0) < 5000) return false;
  }
  return true;
};

const search = async (referralCode, userId, loanAmount = 0) => {
  const guarantor = await GuarantorRepository.findUserByReferralCode(referralCode.trim().toUpperCase());
  if (!guarantor) throw new AppError("Guarantor not found.", 404);
  if (guarantor._id.toString() === userId.toString()) {
    throw new AppError("You cannot select yourself as guarantor.", 400);
  }
  const netSavings = await getNetSavings(guarantor._id);
  if (netSavings < 70000) {
    throw new AppError(`This member has ₦${netSavings.toLocaleString()} in savings. Minimum ₦70,000 required to act as a guarantor.`, 400);
  }
  if (loanAmount > 0) {
    const requiredThreshold = loanAmount * 0.25;
    if (netSavings <= requiredThreshold) {
      throw new AppError(
        `This member's savings (₦${netSavings.toLocaleString()}) must be greater than 25% of the requested loan amount (₦${requiredThreshold.toLocaleString()}).`,
        400
      );
    }
  }
  if (!(await checkSavingsConsistency(guarantor._id))) {
    throw new AppError("This member has not maintained consistent savings. They are not eligible to act as a guarantor.", 400);
  }
  return {
    id: guarantor._id,
    fullName: guarantor.fullName,
    email: guarantor.email,
    phone: guarantor.phone,
    referralCode: guarantor.referralCode,
    tier: guarantor.tier,
    profileImage: guarantor.profileImage,
    netSavings,
  };
};

const getByLoan = async (loanId, userId, role) => {
  const loan = await GuarantorRepository.findLoan(loanId);
  if (!loan) throw new AppError("Loan not found.", 404);
  if (loan.userId.toString() !== userId.toString() && !["super_admin", "finance_manager"].includes(role)) {
    throw new AppError("Unauthorized.", 403);
  }
  const guarantor = await GuarantorRepository.findByLoan(loan._id);
  if (!guarantor) throw new AppError("No guarantor request found.", 404);
  return { guarantor, loan };
};

const getSummaryStats = async (userId) => {
  const [guarantees, user] = await Promise.all([
    GuarantorRepository.findSummaryGuarantees(userId),
    GuarantorRepository.findUserScore(userId),
  ]);
  return {
    activeStanding: guarantees.length,
    activeGuaranteedAmount: guarantees.reduce(
      (sum, item) => sum + (item.remainingGuaranteedBalance ?? item.guaranteedAmount ?? 0),
      0
    ),
    socketScore: user?.socketScore ?? user?.score ?? null,
  };
};

const getDetails = async (token, userId) => {
  const guarantor = await GuarantorRepository.findByToken(token);
  if (!guarantor) throw new AppError("Invalid guarantor link.", 404);
  if (guarantor.tokenExpiresAt && new Date() > guarantor.tokenExpiresAt) {
    return { expired: true };
  }
  const guarantorStats = await getSummaryStats(userId);
  return { guarantor, guarantorStats };
};

const getPending = async (userId) => {
  const [pendingRequests, guarantorStats] = await Promise.all([
    GuarantorRepository.findPendingForUser(userId),
    getSummaryStats(userId),
  ]);
  return { pendingRequests, guarantorStats };
};

/**
 * Respond to Guarantor Request.
 * If rejected: Marks only this guarantor rejected. Keeps loan waiting_guarantor so borrower can replace them.
 */
const respondToRequest = async ({ userId, clientIp, body }) => {
  const {
    token,
    decision,
    address,
    occupation,
    employerName,
    idType,
    idNumber,
    idCardUrl,
    proofOfAddressUrl,
    signatureUrl,
    rejectionReason,
  } = body;

  if (!["accept", "reject"].includes(decision)) {
    throw new AppError("Invalid decision.", 400);
  }

  const guarantorRequest = await GuarantorRepository.findRawByToken(token);
  if (!guarantorRequest) {
    throw new AppError("Guarantor request not found.", 404);
  }

  if (!guarantorRequest.guarantorUserId || guarantorRequest.guarantorUserId.toString() !== userId.toString()) {
    throw new AppError("You are not authorized to respond to this guarantor request.", 403);
  }

  if (guarantorRequest.status !== "pending") {
    throw new AppError(`This request has already been ${guarantorRequest.status}.`, 400);
  }

  if (guarantorRequest.tokenExpiresAt && new Date() > guarantorRequest.tokenExpiresAt) {
    guarantorRequest.status = "expired";
    await guarantorRequest.save();
    throw new AppError("Guarantor request has expired.", 400);
  }

  const loan = await GuarantorRepository.findLoan(guarantorRequest.loanId);
  if (!loan) throw new AppError("Loan not found.", 404);

  if (loan.status !== "waiting_guarantor") {
    throw new AppError("This loan application is no longer awaiting guarantor responses.", 400);
  }

  const loanGuarantor = loan.guarantors?.find(
    (item) => item.verificationToken === guarantorRequest.verificationToken
  );
  if (!loanGuarantor) {
    throw new AppError("Guarantor record attached to this loan was not found.", 404);
  }

  const session = await mongoose.startSession();
  let allGuarantorsAccepted = false;

  try {
    await session.withTransaction(async () => {
      const now = new Date();

      if (decision === "accept") {
        guarantorRequest.status = "accepted";
        guarantorRequest.acceptedAt = now;
        guarantorRequest.ipAddress = clientIp;
        guarantorRequest.address = address || null;
        guarantorRequest.occupation = occupation || null;
        guarantorRequest.employerName = employerName || null;
        guarantorRequest.idType = idType || null;
        guarantorRequest.idNumber = idNumber || null;
        guarantorRequest.idCardUrl = idCardUrl || null;
        guarantorRequest.proofOfAddressUrl = proofOfAddressUrl || null;
        guarantorRequest.signatureUrl = signatureUrl || null;

        loanGuarantor.status = "accepted";
        loanGuarantor.acceptedAt = now;
        loanGuarantor.remainingGuaranteedBalance = loan.remainingBalance || loan.totalRepayable;

        // Check active, non-replaced guarantors
        const activeGuarantors = loan.guarantors.filter((g) => !g.isReplaced);
        allGuarantorsAccepted =
          activeGuarantors.length === 4 &&
          activeGuarantors.every((item) => item.status === "accepted");

        loan.status = allGuarantorsAccepted ? "pending_review" : "waiting_guarantor";
      } else {
        guarantorRequest.status = "rejected";
        guarantorRequest.rejectedAt = now;
        guarantorRequest.rejectionReason = rejectionReason || "Guarantor declined";
        guarantorRequest.ipAddress = clientIp;

        loanGuarantor.status = "rejected";
        loanGuarantor.rejectedAt = now;
        loanGuarantor.rejectionReason = rejectionReason || "Guarantor declined";
        loanGuarantor.remainingGuaranteedBalance = 0;

        // Loan remains alive in waiting_guarantor state
        loan.status = "waiting_guarantor";
      }

      await GuarantorRepository.saveLoan(loan, session);
      await GuarantorRepository.saveGuarantor(guarantorRequest, session);
    });
  } finally {
    await session.endSession();
  }

  // Notifications
  if (decision === "accept") {
    await createNotification({
      userId: guarantorRequest.guarantorUserId,
      type: "guarantor",
      title: "Guarantee Accepted",
      message: `You have accepted the guarantee request for loan ${loan.loanNumber}. Your guarantee will become active only if the loan is approved by admin.`,
      data: {
        loanId: loan._id,
        loanNumber: loan.loanNumber,
        status: "accepted",
      },
    });

    await createNotification({
      userId: loan.userId,
      type: "loan",
      title: "Guarantor Accepted",
      message: `${guarantorRequest.guarantorName} has accepted your loan guarantee request.`,
      data: {
        loanId: loan._id,
        loanNumber: loan.loanNumber,
        guarantorStatus: "accepted",
        loanStatus: loan.status,
      },
    });

    if (allGuarantorsAccepted) {
      await createNotification({
        userId: loan.userId,
        type: "loan",
        title: "All Guarantors Accepted",
        message: "All four guarantors have accepted your loan application. It has been forwarded for admin review.",
        data: {
          loanId: loan._id,
          loanNumber: loan.loanNumber,
          status: "pending_review",
        },
      });
    }

    return {
      message: allGuarantorsAccepted
        ? "Guarantee accepted. All four guarantors have accepted the loan. It is now awaiting admin review."
        : "Guarantee accepted successfully. Waiting for remaining guarantors.",
      guarantorRequest,
      loan: {
        id: loan._id,
        loanNumber: loan.loanNumber,
        status: loan.status,
        allGuarantorsAccepted,
      },
    };
  } else {
    // REJECTION: Notify borrower to replace this specific guarantor
    await createNotification({
      userId: loan.userId,
      type: "loan",
      title: "Guarantor Request Declined",
      message: `${guarantorRequest.guarantorName} declined your guarantor request. Please select an eligible replacement guarantor to proceed.`,
      data: {
        loanId: loan._id,
        loanNumber: loan.loanNumber,
        rejectedGuarantorId: guarantorRequest._id,
        rejectedGuarantorName: guarantorRequest.guarantorName,
        action: "replace_guarantor",
      },
    });

    return {
      message: "Guarantee rejected. The borrower has been notified to select a replacement guarantor.",
      guarantorRequest,
      loan: {
        id: loan._id,
        loanNumber: loan.loanNumber,
        status: loan.status,
      },
    };
  }
};

const GuarantorService = {
  search,
  getByLoan,
  getSummaryStats,
  getDetails,
  getPending,
  respondToRequest,
};

module.exports = { GuarantorService };