/**
 * ReceiptService — transactional receipt delivery for settled payments.
 *
 * Design rules:
 *  - One email per payment, EVER — the dedicated transaction record carries an
 *    atomic claim (`metadata.receiptEmailState`) so a webhook and a frontend
 *    callback processing the same settlement can never both send.
 *  - Email delivery is NEVER allowed to fail an already-settled payment:
 *    a provider outage flips only the receipt status to "failed" and is
 *    logged loudly for ops follow-up.
 *  - Only a genuinely settled transaction (the dedicated record written at
 *    settlement time) triggers a receipt, and the receipt is built from the
 *    ACTUAL record data — never from browser state.
 *
 * Testability: `createReceiptService({ sendEmail, findUser })` injects the
 * two external dependencies; `sendPaymentReceipt` takes the target model per
 * call so tests can supply a mock. The default export is a pre-built
 * instance wired to the real User model and Brevo mailer.
 */

const sendEmailDefault = require("../Utilis/sendEmail");
const receiptTemplate = require("../Utilis/emailTemplates/receipt");

const TYPE_LABELS = {
  deposit: "Savings Deposit",
  withdrawal: "Withdrawal",
  minute_contribution: "Socket Minutes Contribution",
  membership_fee: "Membership Fee",
  loan_repayment: "Loan Repayment",
  loan_disbursement: "Loan Disbursement",
};

const formatNairaAmount = (value) => Number(value || 0).toLocaleString("en-NG");

const formatPaidAt = (value) => {
  const d = value ? new Date(value) : new Date();
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-NG");
};

const buildSubject = (type) => `Your SocketMonnie receipt — ${TYPE_LABELS[type] || "Payment"}`;

const markReceiptState = (Model, reference, state, extra = {}) =>
  Model.findOneAndUpdate(
    { reference },
    { $set: { "metadata.receiptEmailState": state, ...extra } },
    { new: true }
  ).lean();

const createReceiptService = (deps = {}) => {
  const sendEmail = deps.sendEmail || sendEmailDefault;
  const findUser =
    deps.findUser ||
    ((userId) => {
      // Lazy require: keeps the module importable without a live connection.
      const User = require("../Models/UserModel");
      return User.findById(userId).select("fullName email").lean();
    });

  /**
   * Send one receipt email for a settled transaction.
   *
   * @returns {Promise<{ sent: boolean, reason?: string }>}
   *          `sent: true` only when the provider accepted the message.
   */
  const sendPaymentReceipt = async ({
    userId,
    Model,
    type,
    reference,
    transactionId,
    amount,
    currency = "NGN",
    paidAt,
    monthsSettled,
  }) => {
    if (!userId) return { sent: false, reason: "missing_user" };
    if (!Model || typeof Model.findOneAndUpdate !== "function") {
      return { sent: false, reason: "missing_model" };
    }
    if (!reference) return { sent: false, reason: "missing_reference" };

    // 1) Atomic claim — concurrent callers (webhook + callback, or replays)
    //    both attempt it; exactly one gets the document. A "failed" claim is
    //    re-claimable (safe retry), "claiming"/"sent" are not.
    const claimedAt = new Date();
    const claim = await Model.findOneAndUpdate(
      {
        reference,
        "metadata.receiptEmailState": { $nin: ["claiming", "sent"] },
      },
      {
        $set: {
          "metadata.receiptEmailState": "claiming",
          "metadata.receiptEmailClaimedAt": claimedAt,
        },
      },
      { new: true }
    ).lean();

    if (!claim) {
      // Already sent or being sent by the other caller — never duplicate.
      return { sent: false, reason: "already_claimed" };
    }

    try {
      // 2) Resolve the member and their email — never trust caller data.
      const user = await findUser(userId);
      const email = user?.email ? String(user.email).trim() : null;
      if (!email) {
        await markReceiptState(Model, reference, "failed", {
          "metadata.receiptEmailError": "Member has no email address on file.",
        });
        console.error(`[RECEIPT] ✗ missing member email | userId: ${userId} | ref: ${reference}`);
        return { sent: false, reason: "missing_email" };
      }

      const label = TYPE_LABELS[type] || "Payment";
      const amountNaira = formatNairaAmount(amount);
      const html = receiptTemplate(user.fullName, amountNaira, reference, label);
      const subject = buildSubject(type);

      // 3) Delivery — provider outcome decides the final state.
      const result = await sendEmail({ to: email, subject, html });

      if (result?.success) {
        await markReceiptState(Model, reference, "sent", {
          "metadata.receiptEmailSentAt": new Date(),
          "metadata.receiptEmailMessageId": result.messageId || "ok",
        });
        console.log(
          `[RECEIPT] ✔ sent | userId: ${userId} | ref: ${reference} | TX: ${transactionId || "—"} | amount: ₦${amountNaira}`
        );
        return { sent: true };
      }

      const error = result?.error || "unknown provider error";
      await markReceiptState(Model, reference, "failed", {
        "metadata.receiptEmailError": String(error).slice(0, 300),
      });
      console.error(
        `[RECEIPT] ✗ delivery failed | userId: ${userId} | ref: ${reference} | error: ${error}`
      );
      return { sent: false, reason: "provider_failed", error };
    } catch (error) {
      // Payment stays successful — only the receipt is marked failed.
      await markReceiptState(Model, reference, "failed", {
        "metadata.receiptEmailError": String(error?.message || error).slice(0, 300),
      });
      console.error(
        `[RECEIPT] ✗ unexpected error | userId: ${userId} | ref: ${reference} | error: ${error?.message || error}`
      );
      return { sent: false, reason: "error", error: error?.message || String(error) };
    }
  };

  return { sendPaymentReceipt };
};

const defaultInstance = createReceiptService();

/**
 * Call-site friendly wrapper: sends the receipt and converts ANY error into
 * a logged `{ sent: false }` instead of letting it bubble. A payment must
 * never be marked failed because its receipt email failed.
 */
const sendPaymentReceiptSafe = async (params) => {
  try {
    return await defaultInstance.sendPaymentReceipt(params);
  } catch (err) {
    console.error(
      `[RECEIPT] ✗ call-site error | ref: ${params?.reference || "—"} | error: ${err?.message || err}`
    );
    return { sent: false, reason: "error", error: err?.message || String(err) };
  }
};

module.exports = {
  createReceiptService,
  TYPE_LABELS,
  formatNairaAmount,
  buildSubject,
  sendPaymentReceipt: defaultInstance.sendPaymentReceipt,
  sendPaymentReceiptSafe,
};
