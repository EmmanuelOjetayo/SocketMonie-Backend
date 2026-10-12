const { GuarantorService } = require("../Services/GuarantorService");

const buildEstimatedDueDate = (loan) => {
  if (!loan?.createdAt || !loan?.durationMonths) return null;
  const due = new Date(loan.createdAt);
  due.setMonth(due.getMonth() + loan.durationMonths);
  return due;
};

exports.searchGuarantor = async (req, res, next) => {
  try {
    const guarantor = await GuarantorService.search(req.params.referralCode, req.user._id);
    return res.status(200).json({
      success: true,
      guarantor,
    });
  } catch (err) {
    next(err);
  }
};

exports.respondToGuarantorRequest = async (req, res, next) => {
  try {
    const result = await GuarantorService.respondToRequest({
      userId: req.user._id,
      clientIp: req.ip,
      body: req.body,
    });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err) {
    next(err);
  }
};

exports.getGuarantorByLoan = async (req, res, next) => {
  try {
    const { guarantor, loan } = await GuarantorService.getByLoan(req.params.loanId, req.user._id, req.user.role);

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
        verificationSubmitted: guarantor.status === "accepted",
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

exports.getGuarantorDetails = async (req, res, next) => {
  try {
    const details = await GuarantorService.getDetails(req.params.token, req.user?._id);
    if (details.expired) {
      return res.status(400).json({
        success: false,
        expired: true,
        message: "This guarantor invitation has expired.",
      });
    }
    const { guarantor, guarantorStats } = details;

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

exports.getPendingGuarantorRequests = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { pendingRequests, guarantorStats } = await GuarantorService.getPending(userId);

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