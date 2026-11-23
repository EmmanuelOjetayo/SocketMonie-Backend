/**
 * KYC approval lock policy.
 *
 * Owner-approved decision: once an administrator approves a member's KYC,
 * the approved KYC record is locked. Members may no longer modify (or
 * re-submit) KYC information for an account in the `approved` state — they
 * retain read access and, when a submission is rejected, the existing
 * resubmission workflow.
 *
 * Admins keep their explicit permissions; this lock only gates member-facing
 * update endpoints.
 */

const AppError = require("./AppError");

const KYC_LOCKED_STATUS = "approved";

const KYC_LOCKED_MESSAGE =
  "Your KYC has been approved and your details are now locked. You can no longer update your KYC information. Please contact support if you believe this is a mistake.";

const isKycLocked = (kycStatus) => kycStatus === KYC_LOCKED_STATUS;

/**
 * Build the complete KYC lifecycle update for a member document.
 *
 * There is no separate KYC collection — the member document is the source of
 * truth. Keeping the transition here makes it possible to test approval and
 * rejection without loading Mongoose/services, while AdminService still
 * persists the fields in a single document write.
 */
const buildKycStatusUpdate = (status, reason = "", user = {}) => {
  if (status === KYC_LOCKED_STATUS && !user.documentUrl) {
    throw new AppError("No KYC document has been submitted for this member yet.", 400);
  }

  return {
    kycStatus: status,
    kycVerifiedAt: status === KYC_LOCKED_STATUS ? new Date() : null,
    kycRejectionReason: status === "rejected" ? reason : null,
  };
};

module.exports = {
  KYC_LOCKED_STATUS,
  KYC_LOCKED_MESSAGE,
  isKycLocked,
  buildKycStatusUpdate,
};
