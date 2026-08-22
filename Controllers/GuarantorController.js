const Savings = require("../Models/SavingsModel");
const crypto = require("crypto");

const Guarantor = require("../Models/GuarantorModel");
const Loan = require("../Models/LoanModel");
const User = require("../Models/UserModel");

const { createNotification } = require("../Utilis/notificationHelper");
const { sendEmail } = require("../Utilis/sendEmail");


// GET /api/guarantors/search/:referralCode

exports.searchGuarantor = async (req, res, next) => {
  try {
    const { referralCode } = req.params;

    const guarantor = await User.findOne({
      referralCode: referralCode.trim().toUpperCase(),
    }).select(
      "_id fullName email phone referralCode tier profileImage"
    );

    if (!guarantor) {
      return res.status(404).json({
        success: false,
        message: "Guarantor not found.",
      });
    }

    // Cannot guarantee yourself
    if (guarantor._id.toString() === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: "You cannot select yourself as guarantor.",
      });
    }

    // Check guarantor savings
    const completedSavings = await Savings.find({
      userId: guarantor._id,
      status: "completed",
    });

    const netSavings = completedSavings.reduce((sum, item) => {
      if (item.type === "withdrawal") {
        return sum - item.amount;
      }
      if (item.type === "deposit") {
        return sum + item.amount;
      }
      return sum;
    }, 0);

    if (netSavings < 70000) {
      return res.status(400).json({
        success: false,
        message:
          "This member is not eligible to act as a guarantor.",
      });
    }

    return res.status(200).json({
      success: true,
      guarantor: {
        id: guarantor._id,
        fullName: guarantor.fullName,
        email: guarantor.email,
        phone: guarantor.phone,
        referralCode: guarantor.referralCode,
        tier: guarantor.tier,
        profileImage: guarantor.profileImage,
        netSavings,
      },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/guarantors/respond
// POST /api/guarantors/respond
exports.respondToGuarantorRequest = async (req, res, next) => {
  try {
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
    } = req.body;

    // ======================================
    // Validate decision
    // ======================================

    if (!["accept", "reject"].includes(decision)) {
      return res.status(400).json({
        success: false,
        message: "Invalid decision.",
      });
    }

    // ======================================
    // Find guarantor request
    // ======================================

    const guarantorRequest = await Guarantor.findOne({
      verificationToken: token,
    });

    if (!guarantorRequest) {
      return res.status(404).json({
        success: false,
        message: "Guarantor request not found.",
      });
    }

    // ======================================
    // SECURITY:
    // Only invited guarantor can respond
    // ======================================

    if (
      !guarantorRequest.guarantorUserId ||
      guarantorRequest.guarantorUserId.toString() !==
        req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message:
          "You are not authorized to respond to this guarantor request.",
      });
    }

    // ======================================
    // Request must still be pending
    // ======================================

    if (guarantorRequest.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `This request has already been ${guarantorRequest.status}.`,
      });
    }

    // ======================================
    // Check expiry
    // ======================================

    if (
      guarantorRequest.tokenExpiresAt &&
      new Date() > guarantorRequest.tokenExpiresAt
    ) {
      guarantorRequest.status = "expired";
      await guarantorRequest.save();

      return res.status(400).json({
        success: false,
        message: "Guarantor request has expired.",
      });
    }

    // ======================================
    // Find loan
    // ======================================

    const loan = await Loan.findById(guarantorRequest.loanId);

    if (!loan) {
      return res.status(404).json({
        success: false,
        message: "Loan not found.",
      });
    }

    // ======================================
    // Loan must still be waiting for guarantors
    // ======================================

    if (loan.status !== "waiting_guarantor") {
      return res.status(400).json({
        success: false,
        message:
          "This loan application is no longer awaiting guarantor responses.",
      });
    }

    // ======================================
    // Find this specific guarantor inside loan
    // ======================================

    const loanGuarantor = loan.guarantors?.find(
      (item) =>
        item.verificationToken ===
        guarantorRequest.verificationToken
    );

    if (!loanGuarantor) {
      return res.status(404).json({
        success: false,
        message:
          "Guarantor record attached to this loan was not found.",
      });
    }

    // ==========================================================
    // ACCEPT
    // ==========================================================

    if (decision === "accept") {
      const acceptedAt = new Date();

      // --------------------------------------
      // Update standalone guarantor record
      // --------------------------------------

      guarantorRequest.status = "accepted";
      guarantorRequest.acceptedAt = acceptedAt;
      guarantorRequest.ipAddress = req.ip;

      guarantorRequest.address = address || null;
      guarantorRequest.occupation = occupation || null;
      guarantorRequest.employerName = employerName || null;
      guarantorRequest.idType = idType || null;
      guarantorRequest.idNumber = idNumber || null;
      guarantorRequest.idCardUrl = idCardUrl || null;
      guarantorRequest.proofOfAddressUrl =
        proofOfAddressUrl || null;
      guarantorRequest.signatureUrl = signatureUrl || null;

      // --------------------------------------
      // IMPORTANT:
      // Accepted ≠ active
      // --------------------------------------

      loanGuarantor.status = "accepted";
      loanGuarantor.acceptedAt = acceptedAt;
      loanGuarantor.approvedAt = acceptedAt;

      loanGuarantor.remainingGuaranteedBalance =
        loan.remainingBalance || loan.totalRepayable;

      // --------------------------------------
      // Check all 3 guarantors
      // --------------------------------------

      const allGuarantorsAccepted =
        loan.guarantors.length === 3 &&
        loan.guarantors.every(
          (item) => item.status === "accepted"
        );

      // --------------------------------------
      // Loan remains waiting until all 3 accept
      // --------------------------------------

      if (allGuarantorsAccepted) {
        loan.status = "pending_review";
      } else {
        loan.status = "waiting_guarantor";
      }

      // --------------------------------------
      // Save both records
      // --------------------------------------

      await loan.save();
      await guarantorRequest.save();

      // --------------------------------------
      // Notify guarantor
      // --------------------------------------

      await createNotification({
        userId: guarantorRequest.guarantorUserId,
        type: "guarantor",
        title: "Guarantee Accepted",
        message: `You have accepted the guarantee request for loan ${loan.loanNumber}. Your guarantee will become active only if the loan is approved and activated by the administrator.`,
        data: {
          loanId: loan._id,
          loanNumber: loan.loanNumber,
          guaranteedAmount:
            loanGuarantor.guaranteedAmount,
          remainingGuaranteedBalance:
            loanGuarantor.remainingGuaranteedBalance,
          status: "accepted",
        },
      });

      // --------------------------------------
      // Notify borrower about THIS guarantor
      // --------------------------------------

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

      // --------------------------------------
      // If all 3 accepted
      // --------------------------------------

      if (allGuarantorsAccepted) {
        await createNotification({
          userId: loan.userId,
          type: "loan",
          title: "All Guarantors Accepted",
          message:
            "All three guarantors have accepted your loan application. Your application has now been forwarded for admin review.",
          data: {
            loanId: loan._id,
            loanNumber: loan.loanNumber,
            status: "pending_review",
          },
        });
      }

      return res.status(200).json({
        success: true,
        message: allGuarantorsAccepted
          ? "Guarantee accepted. All three guarantors have accepted the loan. It is now awaiting admin review."
          : "Guarantee accepted successfully. Waiting for the remaining guarantors.",
        guarantorRequest,
        loan: {
          id: loan._id,
          loanNumber: loan.loanNumber,
          status: loan.status,
          allGuarantorsAccepted,
        },
      });
    }

    // ==========================================================
    // REJECT
    // ==========================================================

    guarantorRequest.status = "rejected";
    guarantorRequest.rejectedAt = new Date();
    guarantorRequest.ipAddress = req.ip;

    loanGuarantor.status = "rejected";
    loanGuarantor.rejectedAt = new Date();
    loanGuarantor.remainingGuaranteedBalance = 0;

    // ======================================
    // ANY rejection cancels entire loan
    // ======================================

    loan.status = "rejected";

    await loan.save();
    await guarantorRequest.save();

    // --------------------------------------
    // Notify borrower
    // --------------------------------------

    await createNotification({
      userId: loan.userId,
      type: "loan",
      title: "Loan Application Cancelled",
      message: `${guarantorRequest.guarantorName} declined your guarantor request. Because all three guarantors are required, your entire loan application has been cancelled.`,
      data: {
        loanId: loan._id,
        loanNumber: loan.loanNumber,
        status: "rejected",
      },
    });

    // --------------------------------------
    // Notify remaining guarantors
    // --------------------------------------

    const remainingGuarantors =
      loan.guarantors.filter(
        (item) =>
          item.status === "pending" &&
          item.userId
      );

    await Promise.all(
      remainingGuarantors.map((item) =>
        createNotification({
          userId: item.userId,
          type: "guarantor",
          title: "Guarantee Request Cancelled",
          message: `The loan application ${loan.loanNumber} has been cancelled because another guarantor declined the request.`,
          data: {
            loanId: loan._id,
            loanNumber: loan.loanNumber,
            status: "rejected",
          },
        })
      )
    );

    return res.status(200).json({
      success: true,
      message:
        "Guarantee rejected. The entire loan application has been cancelled.",
      guarantorRequest,
      loan: {
        id: loan._id,
        loanNumber: loan.loanNumber,
        status: loan.status,
      },
    });
  } catch (err) {
    next(err);
  }
};


// GET /api/guarantors/loan/:loanId
exports.getGuarantorByLoan = async (req, res, next) => {
  try {
    const { loanId } = req.params;

    const loan = await Loan.findById(loanId);

    if (!loan) {
      return res.status(404).json({
        success: false,
        message: "Loan not found.",
      });
    }

    // Borrower or Admin only
    if (
      loan.userId.toString() !== req.user._id.toString() &&
      !["super_admin", "finance_manager"].includes(req.user.role)
    ) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized.",
      });
    }

    const guarantor = await Guarantor.findOne({
      loanId: loan._id,
    });

    if (!guarantor) {
      return res.status(404).json({
        success: false,
        message: "No guarantor request found.",
      });
    }

    return res.status(200).json({
      success: true,
      guarantor: {
        id: guarantor._id,
        fullName: guarantor.guarantorName,
        email: guarantor.guarantorEmail,
        phone: guarantor.guarantorPhone,
        relationship: guarantor.relationship,

        status: guarantor.status,
        acceptedAt: guarantor.acceptedAt,
        rejectionReason: guarantor.rejectionReason,

        expiresAt: guarantor.tokenExpiresAt,

        verificationSubmitted:
          guarantor.status === "accepted",

        verificationDocuments: {
          idCard: !!guarantor.idCardUrl,
          proofOfAddress: !!guarantor.proofOfAddressUrl,
          signature: !!guarantor.signatureUrl,
        },
      },

      loan: {
        id: loan._id,
        loanNumber: loan.loanNumber,
        amount: loan.principalAmount,
        totalRepayable: loan.totalRepayable,
        status: loan.status,
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Stats about the CURRENT guarantor (req.user) — how many guarantees
 * they're currently on the hook for, the total amount, and their score.
 *
 * NOTE: `scoreField` below assumes the User model exposes the "Socket
 * Score" as `user.score`. If your schema uses a different field name
 * (e.g. `creditScore`, `socketScore`), update the `.select()` and the
 * property read below to match.
 */
const getGuarantorSummaryStats = async (guarantorUserId) => {
  const [activeGuarantees, currentUser] = await Promise.all([
    Guarantor.find({
      guarantorUserId,
      status: { $in: ["accepted", "active"] },
    }),
    User.findById(guarantorUserId).select("score"),
  ]);

  const activeStanding = activeGuarantees.length;
  const activeGuaranteedAmount = activeGuarantees.reduce(
    (sum, item) =>
      sum + (item.remainingGuaranteedBalance ?? item.guaranteedAmount ?? 0),
    0
  );

  return {
    activeStanding,
    activeGuaranteedAmount,
    socketScore: currentUser?.score ?? null,
  };
};

// Builds an estimated due date since a real one only exists once the
// loan is disbursed and installments are generated (see LoanController's
// approveAndDisburseLoan). Before that, this is application date + tenor.
const buildEstimatedDueDate = (loan) => {
  if (!loan?.createdAt || !loan?.durationMonths) return null;
  const due = new Date(loan.createdAt);
  due.setMonth(due.getMonth() + loan.durationMonths);
  return due;
};

// GET /api/guarantors/verify/:token
exports.getGuarantorDetails = async (req, res, next) => {
  try {
    const { token } = req.params;

    const guarantor = await Guarantor.findOne({
      verificationToken: token,
    })
      .populate(
        "loanId",
        `
        loanNumber
        principalAmount
        interestAmount
        interestRate
        totalRepayable
        durationMonths
        purpose
        loanType
        status
        createdAt
        `
      )
      .populate(
        "applicantId",
        `
        fullName
        email
        phone
        referralCode
        profileImage
        kycStatus
        createdAt
        `
      );

    if (!guarantor) {
      return res.status(404).json({
        success: false,
        message: "Invalid guarantor link.",
      });
    }

    if (new Date() > guarantor.tokenExpiresAt) {
      return res.status(400).json({
        success: false,
        expired: true,
        message: "This guarantor invitation has expired.",
      });
    }

    const guarantorStats = await getGuarantorSummaryStats(req.user._id);

    return res.status(200).json({
      success: true,

      guarantorRequest: {
        id: guarantor._id,

        status: guarantor.status,

        expiresAt: guarantor.tokenExpiresAt,

        guarantor: {
          fullName: guarantor.guarantorName,
          email: guarantor.guarantorEmail,
          phone: guarantor.guarantorPhone,
        },

        applicant: {
          fullName: guarantor.applicantId?.fullName,
          email: guarantor.applicantId?.email,
          phone: guarantor.applicantId?.phone,
          referralCode: guarantor.applicantId?.referralCode,
          profileImage: guarantor.applicantId?.profileImage,
          memberSince: guarantor.applicantId?.createdAt,
          verified: guarantor.applicantId?.kycStatus === "approved",
        },

        loan: {
          id: guarantor.loanId?._id,
          loanNumber: guarantor.loanId?.loanNumber,
          amount: guarantor.loanId?.principalAmount,
          interest: guarantor.loanId?.interestAmount,
          interestRate: guarantor.loanId?.interestRate,
          totalRepayable: guarantor.loanId?.totalRepayable,
          durationMonths: guarantor.loanId?.durationMonths,
          purpose: guarantor.loanId?.purpose,
          loanType: guarantor.loanId?.loanType,
          status: guarantor.loanId?.status,
          estimatedDueDate: buildEstimatedDueDate(guarantor.loanId),
        },

        guarantorStats,
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/guarantors/pending-requests
exports.getPendingGuarantorRequests = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const pendingRequests = await Guarantor.find({
      guarantorUserId: userId,
      status: "pending",
    })
      .populate(
        "loanId",
        "loanNumber principalAmount interestAmount interestRate totalRepayable durationMonths purpose loanType status createdAt"
      )
      .populate(
        "applicantId",
        "fullName email phone referralCode profileImage kycStatus createdAt"
      )
      .lean();

    const guarantorStats = await getGuarantorSummaryStats(userId);

    // Reshape each raw Guarantor doc into the SAME shape getGuarantorDetails
    // returns (applicant/loan instead of applicantId/loanId), so the
    // GuarantorVerify component works identically regardless of whether it
    // was opened via a token link or via this list. Previously these two
    // endpoints returned different shapes, which is why opening a request
    // from this list left the borrower details blank.
    const normalized = pendingRequests.map((item) => ({
      ...item,
      expiresAt: item.tokenExpiresAt,
      applicant: {
        fullName: item.applicantId?.fullName,
        email: item.applicantId?.email,
        phone: item.applicantId?.phone,
        referralCode: item.applicantId?.referralCode,
        profileImage: item.applicantId?.profileImage,
        memberSince: item.applicantId?.createdAt,
        verified: item.applicantId?.kycStatus === "approved",
      },
      loan: {
        id: item.loanId?._id,
        loanNumber: item.loanId?.loanNumber,
        amount: item.loanId?.principalAmount,
        interest: item.loanId?.interestAmount,
        interestRate: item.loanId?.interestRate,
        totalRepayable: item.loanId?.totalRepayable,
        durationMonths: item.loanId?.durationMonths,
        purpose: item.loanId?.purpose,
        loanType: item.loanId?.loanType,
        status: item.loanId?.status,
        estimatedDueDate: buildEstimatedDueDate(item.loanId),
      },
      guarantorStats,
      verificationToken: item.verificationToken,
    }));

    return res.status(200).json({
      success: true,
      pendingRequests: normalized,
    });
  } catch (err) {
    next(err);
  }
};