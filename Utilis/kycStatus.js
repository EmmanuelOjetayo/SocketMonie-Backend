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

const KYC_LOCKED_STATUS = "approved";

const KYC_LOCKED_MESSAGE =
  "Your KYC has been approved and your details are now locked. You can no longer update your KYC information. Please contact support if you believe this is a mistake.";

const isKycLocked = (kycStatus) => kycStatus === KYC_LOCKED_STATUS;

module.exports = { KYC_LOCKED_STATUS, KYC_LOCKED_MESSAGE, isKycLocked };
