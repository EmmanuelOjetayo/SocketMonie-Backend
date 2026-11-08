/**
 * Backward-compatible wrapper.
 * Services import this as: const sendEmail = require("../Utilis/sendEmail");
 * Delegates to the Brevo SDK mailer.
 */
const { sendEmail: brevoSend } = require("./mailer");

/**
 * Mask an email for logs: "praisee827@gmail.com" -> "pr********@gmail.com".
 * Full recipient addresses are PII — never log them unmasked. OTPs,
 * passwords and API keys are never part of anything logged here.
 */
const maskEmail = (email) =>
  String(email || "").replace(/^([^@]{1,2})[^@]*(@.*)$/, "$1********$2");

const sendEmail = async ({ to, subject, html }) => {
  console.log(
    `[email] sending via Brevo → to=${maskEmail(to)} subject="${subject}"`
  );

  const result = await brevoSend({ to, subject, html });

  if (result.success) {
    console.log(
      `[email] ✅ delivered (messageId=${result.messageId || "ok"})`
    );
  } else {
    // The vendor error here is the ground truth for "registered but no OTP
    // email" — e.g. missing BREVO_API_KEY, unverified sender, Brevo 401/422.
    console.error(
      `[email] ❌ delivery FAILED → to=${maskEmail(to)} subject="${subject}" error=${result.error || "unknown"}`
    );
  }

  return {
    success: result.success,
    message: result.success ? "Email sent successfully." : result.error,
    error: result.error,
  };
};

module.exports = sendEmail;
