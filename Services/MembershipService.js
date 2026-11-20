/**
 * MembershipService — membership fee payment lifecycle.
 *
 * Membership fee payments use MembershipTransaction as their dedicated
 * checkout record. Settlement is webhook-authoritative: the signed
 * Flutterwave webhook (handleMembershipFeeWebhook in PaymentService) flips
 * the member's membershipFeePaid flag and finalises the MembershipTransaction
 * record. No browser callback may confirm this payment.
 */

const crypto = require("crypto");
const { SavingsRepository } = require("../Repositories/SavingsRepository");
const { FLW_PUBLIC_KEY, FLW_SUBACCOUNT_ID } = require("../Utilis/Flutterwave");
const MembershipTransaction = require("../Models/MembershipTransactionModel");
const AppError = require("../Utilis/AppError");
const { MEMBERSHIP_FEE_AMOUNT } = require("../Config/constants");

const initializeMembershipFee = async (userId) => {
  const user = await SavingsRepository.findUserById(userId);
  if (!user) {
    throw new AppError("User not found.", 404);
  }

  if (user.membershipFeePaid) {
    throw new AppError("Membership fee has already been paid for this account.", 400);
  }

  // Reference shape (restored): `MEM_<ts>_<hex>_<userId[-6]>` — underscore
  // format REQUIRED because the webhook dispatcher (processWebhook) routes
  // by `reference.startsWith("MEM_")`, and the reconciliation sweep filters
  // `/^MEM_/`. Hyphen refs (fix 2) never reached their handler.
  const tx_ref = `MEM_${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${user._id
    .toString()
    .slice(-6)}`;
  user.membershipFeeTxRef = tx_ref;
  await user.save();

  // Dedicated pending payment intent. Webhook settlement resolves this record
  // by reference; no callback is allowed to confirm it.
  await MembershipTransaction.findOneAndUpdate(
    { reference: tx_ref },
    {
      $setOnInsert: {
        userId: user._id,
        type: "membership_fee",
        reference: tx_ref,
        amount: MEMBERSHIP_FEE_AMOUNT,
        currency: "NGN",
        status: "pending",
        method: "flutterwave",
        paidAt: null,
        metadata: { source: "initializeMembershipFee" },
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return {
    publicKey: FLW_PUBLIC_KEY,
    public_key: FLW_PUBLIC_KEY,
    reference: tx_ref,
    tx_ref,
    txRef: tx_ref,
    amount: MEMBERSHIP_FEE_AMOUNT,
    currency: "NGN",
    // Working-project customer shape (fix 1): only documented keys and
    // never an EMPTY phone — Flutterwave's telemetry/event endpoints 400
    // on empty customer fields (`key customer.id must not contain '.`
    // surfaced from exactly this checkout).
    customer: {
      email: user.email,
      name: user.fullName,
      phone_number: user.phone || "08000000000",
    },
    customizations: {
      title: "SocketMonnie Membership Fee",
      description: "Pay 1000 NGN to continue using the service.",
      logo: process.env.APP_LOGO || "",
    },
    meta: { userId: user._id.toString(), type: "membership_fee" },
    metadata: { userId: user._id.toString(), type: "membership_fee" },
    // Split-payment subaccount — present ONLY in this one-time checkout payload.
    subaccount_id: FLW_SUBACCOUNT_ID || undefined,
  };
};

const MembershipService = {
  initializeMembershipFee,
};

module.exports = { MembershipService };
