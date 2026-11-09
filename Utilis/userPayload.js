/**
 * Central user-payload normalization (single source of truth for the
 * profile-picture URL exposed to the frontend). The DB historically used
 * `selfieUrl` for the onboarding selfie; the canonical API/frontend field is
 * now `avatarUrl`. This helper maps legacy stores → `avatarUrl` at the
 * auth/user-response boundary so components never scatter field fallbacks.
 */
const SENSITIVE_KEYS = [
  "password",
  "otp",
  "otpExpiresAt",
  "resetPasswordOTP",
  "resetPasswordOTPExpiresAt",
  "transactionPin",
  "pinResetOTP",
  "pinResetOTPExpiresAt",
];

const toSafeUserPayload = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const obj = typeof raw.toObject === "function" ? raw.toObject() : { ...raw };
  for (const key of SENSITIVE_KEYS) delete obj[key];
  obj.avatarUrl = obj.avatarUrl || obj.selfieUrl || null;
  obj.selfieUrl = obj.selfieUrl || obj.avatarUrl || null;
  return obj;
};

module.exports = { toSafeUserPayload, SENSITIVE_KEYS };
