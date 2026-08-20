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

      return sum + item.amount;
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

    if (!["accept", "reject"].includes(decision)) {
      return res.status(400).json({
        success: false,
        message: "Invalid decision.",
      });
    }

    const guarantorRequest = await Guarantor.findOne({
      verificationToken: token,
    });

    if (!guarantorRequest) {
      return res.status(404).json({
        success: false,
        message: "Guarantor request not found.",
      });
    }

    if (guarantorRequest.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `This request has already been ${guarantorRequest.status}.`,
      });
    }

    if (new Date() > guarantorRequest.tokenExpiresAt) {
      guarantorRequest.status = "expired";
      await guarantorRequest.save();

      return res.status(400).json({
        success: false,
        message: "Guarantor request has expired.",
      });
    }

    const loan = await Loan.findById(guarantorRequest.loanId);

    if (!loan) {
      return res.status(404).json({
        success: false,
        message: "Loan not found.",
      });
    }

    // ======================================
    // ACCEPT
    // ======================================

    if (decision === "accept") {

      guarantorRequest.status = "accepted";
      guarantorRequest.acceptedAt = new Date();
      guarantorRequest.ipAddress = req.ip;

      guarantorRequest.address = address || null;
      guarantorRequest.occupation = occupation || null;
      guarantorRequest.employerName = employerName || null;
      guarantorRequest.idType = idType || null;
      guarantorRequest.idNumber = idNumber || null;
      guarantorRequest.idCardUrl = idCardUrl || null;
      guarantorRequest.proofOfAddressUrl =
        proofOfAddressUrl || null;
      guarantorRequest.signatureUrl =
        signatureUrl || null;

      const loanGuarantor = loan.guarantors?.find(
        (item) => item.verificationToken === guarantorRequest.verificationToken
      );
      if (loanGuarantor) {
        loanGuarantor.status = "accepted";
        loanGuarantor.acceptedAt = new Date();
      }
      if (loan.guarantors?.length === 3 && loan.guarantors.every((item) => item.status === "accepted")) {
        loan.status = "pending_review";
      }

      await loan.save();

    }

    // ======================================
    // REJECT
    // ======================================

    else {

      guarantorRequest.status = "rejected";
      loan.status = "rejected";

      const loanGuarantor = loan.guarantors?.find(
        (item) => item.verificationToken === guarantorRequest.verificationToken
      );
      if (loanGuarantor) loanGuarantor.status = "rejected";

      await loan.save();

    }

    await guarantorRequest.save();

    await createNotification({
      userId: loan.userId,
      type: "loan",
      title:
        decision === "accept"
          ? "Guarantor Accepted"
          : "Guarantor Declined",
      message:
        decision === "accept"
          ? `${guarantorRequest.guarantorName} accepted your loan guarantee request. Your application is now awaiting admin review.`
          : `${guarantorRequest.guarantorName} declined your loan guarantee request.`,
    });

    return res.status(200).json({
      success: true,
      message:
        decision === "accept"
          ? "Guarantee accepted successfully."
          : "Guarantee rejected successfully.",
      guarantorRequest,
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
        totalRepayable
        durationMonths
        purpose
        loanType
        status
        `
      )
      .populate(
        "applicantId",
        `
        fullName
        email
        phone
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
        },

        loan: {
          id: guarantor.loanId?._id,
          loanNumber: guarantor.loanId?.loanNumber,
          amount: guarantor.loanId?.principalAmount,
          interest: guarantor.loanId?.interestAmount,
          totalRepayable: guarantor.loanId?.totalRepayable,
          durationMonths: guarantor.loanId?.durationMonths,
          purpose: guarantor.loanId?.purpose,
          loanType: guarantor.loanId?.loanType,
          status: guarantor.loanId?.status,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};