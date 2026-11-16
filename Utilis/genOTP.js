const crypto = require("crypto");

/**
 * Cryptographically secure 4-digit OTP generator.
 *
 * Uses `crypto.randomInt` (CSPRNG-backed) instead of `Math.random()` so the
 * OTP cannot be predicted/inferred from seed entropy. Shared by the Transaction
 * PIN reset flow and the account auth (verify/register/forgot-password) flows.
 */
const genOTP = () => {
  return String(crypto.randomInt(1000, 10000));
};

module.exports = genOTP;
