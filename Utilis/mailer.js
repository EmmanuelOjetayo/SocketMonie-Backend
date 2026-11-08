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
    // This is THE root cause for "registered but no OTP email" when the key
    // is missing on a freshly deployed environment. Never log the key value.
    console.error(
      "❌ [email] BREVO_API_KEY not set — email delivery skipped entirely. " +
        "Set the xkeysib-... key from Brevo dashboard → SMTP & API → API keys."
    );
    return { success: false, error: "BREVO_API_KEY not configured" };
  }
  if (!senderEmail) {
    console.error(
      "❌ [email] No sender configured — set BREVO_SENDER (verified sender email) or EMAIL_USER. " +
        "Brevo rejects sends with an undefined sender."
    );
    return { success: false, error: "Email sender not configured (BREVO_SENDER/EMAIL_USER missing)" };
  }

  try {
    const result = await getClient().transactionalEmails.sendTransacEmail({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    });

    const messageId = result?.messageId || result?.body?.messageId || "ok";
    console.log(`[email] ✅ Brevo accepted send (messageId=${messageId})`);
    return { success: true, messageId };
  } catch (error) {
    console.error(
      `[email] ❌ Brevo send threw: ${error.message || error}` +
        (error.status ? ` (HTTP ${error.status})` : "")
    );
    return { success: false, error: error.message || String(error) };
  }
}

module.exports = { sendEmail };
