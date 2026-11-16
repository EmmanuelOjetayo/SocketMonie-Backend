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
const senderName = process.env.BREVO_SENDER_NAME || "SocketMonnie";

// Minimal, dependency-free HTML → plain text fallback. Deliverability tools
// (Gmail/Outlook) score multipart/alternative messages more favourably than
// HTML-only, so every send carries a readable text part automatically.
const htmlToText = (html) => {
  const input = String(html || "");

  const blockClose = /<\/(p|div|table|tr|td|h1|h2|h3|h4|li|ul|ol|section|pre|blockquote)\s*>/gi;
  const lineBreak = /<br\s*\/?>/gi;

  let text = input
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(blockClose, "\n")
    .replace(lineBreak, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
};

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
      // Always send a text/plain counterpart (unless one is supplied) —
      // multipart messages are treated as more legitimate by spam filters.
      textContent: htmlToText(html),
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
