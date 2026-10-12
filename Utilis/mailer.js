/**
 * Brevo (formerly Sendinblue) email sender.
 * Uses @getbrevo/brevo v6 SDK — no SMTP, no nodemailer.
 *
 * Env vars required:
 *   BREVO_API_KEY  — Brevo API key (xkeysib-...)
 *   BREVO_SENDER   — verified sender email (optional, falls back to EMAIL_USER)
 */
const { BrevoClient } = require("@getbrevo/brevo");

const apiKey = process.env.BREVO_API_KEY;
const senderEmail = process.env.BREVO_SENDER || process.env.EMAIL_USER;
const senderName = process.env.BREVO_SENDER_NAME || "Socket Moni";

let client = null;

function getClient() {
  if (!client) {
    client = new BrevoClient({ apiKey });
  }
  return client;
}

/**
 * Send a transactional email via Brevo.
 * @param {{ to: string, subject: string, html: string }} options
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendEmail({ to, subject, html }) {
  if (!apiKey) {
    console.error("❌ BREVO_API_KEY not set — email skipped.");
    return { success: false, error: "BREVO_API_KEY not configured" };
  }

  try {
    const result = await getClient().transactionalEmails.sendTransacEmail({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    });

    const messageId = result?.messageId || result?.body?.messageId || "ok";
    console.log("✅ Brevo email sent:", messageId);
    return { success: true, messageId };
  } catch (error) {
    console.error("❌ Brevo email failed:", error.message || error);
    return { success: false, error: error.message || String(error) };
  }
}

module.exports = { sendEmail };
