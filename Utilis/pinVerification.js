const bcrypt = require("bcrypt");
const AppError = require("./AppError");

/**
 * Verify a submitted Transaction PIN against a stored bcrypt hash.
 *
 * This helper is intentionally small: it has no repository or response logic,
 * so it can be tested without loading Mongoose. Callers must invoke it BEFORE
 * fetching any sensitive KYC data and must never pass the raw PIN to logs or
 * response payloads.
 */
const verifyTransactionPin = async (pin, pinRecord) => {
  if (!pinRecord) throw new AppError("User account not found", 404);
  if (!pinRecord.transactionPin) {
    throw new AppError("Transaction PIN not set. Please set a PIN first.", 400);
  }

  const isValid = await bcrypt.compare(String(pin || ""), pinRecord.transactionPin);
  if (!isValid) throw new AppError("Invalid transaction PIN.", 400);

  return true;
};

module.exports = { verifyTransactionPin };
