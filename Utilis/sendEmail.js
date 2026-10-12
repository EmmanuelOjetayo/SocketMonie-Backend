/**
 * Backward-compatible wrapper.
 * Services import this as: const sendEmail = require("../Utilis/sendEmail");
 * Delegates to the Brevo SDK mailer.
 */
const { sendEmail: brevoSend } = require("./mailer");

const sendEmail = async ({ to, subject, html }) => {
  const result = await brevoSend({ to, subject, html });
  return {
    success: result.success,
    message: result.success ? "Email sent successfully." : result.error,
    error: result.error,
  };
};

module.exports = sendEmail;
