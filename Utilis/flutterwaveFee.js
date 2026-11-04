/**
 * Shared Flutterwave processing-fee helper (single source of truth).
 *
 * Preserves the SocketMonnie pricing model:
 * 1.5% + ₦100 (waived under ₦2,500), capped at ₦2,000 — grossed up so the
 * member covers the processing fee.
 */
const calculateFlutterwaveFee = (amount) => {
  const percentage = 0.015;
  const fixedFee = amount >= 2500 ? 100 : 0;
  const cap = 2000;

  // Standard gross-up formula
  let totalPayable = Math.ceil((amount + fixedFee) / (1 - percentage));
  let fee = totalPayable - amount;

  // Apply maximum cap of ₦2,000 on the fee
  if (fee > cap) {
    fee = cap;
    totalPayable = amount + cap;
  }

  return { fee, totalPayable };
};

module.exports = { calculateFlutterwaveFee };
