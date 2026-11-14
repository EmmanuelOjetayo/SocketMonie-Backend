/**
 * Pure helpers for authoritative payment-status reporting.
 *
 * Kept dependency-free so both the API layer and unit tests can use them
 * without loading mongoose/cloudinary/axios (which keeps the process alive).
 */

/** Canonical client status: "successful" | "pending" | "failed". */
const CANONICAL_STATUS = {
  completed: "successful",
  successful: "successful",
  success: "successful",
  approved: "successful",
  paid: "successful",
  pending: "pending",
  pending_approval: "pending",
  processing: "pending",
  failed: "failed",
  rejected: "failed",
  cancelled: "failed",
  terminated: "failed",
  reversed: "failed",
};

/**
 * Map an internal persistence status onto the canonical client status.
 * Unknown values default to "pending" — the success page only renders the
 * green receipt on an explicitly-confirmed "successful".
 */
const toCanonicalStatus = (value) =>
  CANONICAL_STATUS[String(value || "").toLowerCase()] || "pending";

/**
 * Payment type label derived from the server-generated reference prefix.
 * References are generated server-side at initiation, so the prefix is
 * authoritative for routing/labels.
 */
const typeFromReference = (ref) => {
  const value = String(ref || "");
  if (value.startsWith("DEP_")) return "deposit";
  if (value.startsWith("WTH_")) return "withdrawal";
  if (value.startsWith("MIN_")) return "minute_contribution";
  if (value.startsWith("MEM_")) return "membership_fee";
  if (value.startsWith("LRP_") || value.startsWith("RPL_") || value.startsWith("LRP-")) return "loan_repayment";
  return null;
};

/** True when the reference belongs to a Flutterwave-reconcilable flow. */
const isReconcilableReference = (ref) =>
  ["DEP_", "LRP_", "RPL_", "LRP-", "MEM_", "MIN_"].some((prefix) =>
    String(ref || "").startsWith(prefix)
  );

/**
 * Provider statuses that count as a successful payment outcome.
 * Flutterwave uses "successful" for most flows, but observed payloads
 * (checkout callback / certain bank-transfer and sandbox outcomes) report
 * "completed" alongside an approval signal such as charge_response_code "00".
 */
const SUCCESS_STATUSES = ["successful", "completed"];

/** True when the provider status is a known successful payment outcome. */
const isSuccessfulStatus = (value) =>
  SUCCESS_STATUSES.includes(String(value || "").toLowerCase());

module.exports = {
  CANONICAL_STATUS,
  toCanonicalStatus,
  typeFromReference,
  isReconcilableReference,
  SUCCESS_STATUSES,
  isSuccessfulStatus,
};
