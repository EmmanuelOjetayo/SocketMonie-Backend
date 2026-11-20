const { wrapEmail, codeBlock, securityNote, escapeHtml } = require("./layout");

// Usage: forgotPasswordTemplate(fullName, otp, context)
//   context — "password" (default) or "transaction PIN"; both call sites pass
//   their own context so the wording always matches the reset flow.
const forgotPasswordTemplate = (fullName, otp, context = "password") => {
  const name = escapeHtml(fullName);
  const what = String(context || "password").trim();

  const bodyHtml = `
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;">Hi ${name},</p>
            <p style="margin:0 0 18px 0;font-size:14px;line-height:1.65;">
              We received a request to reset your ${escapeHtml(what)}.
              Enter the code below to continue. For your security, this code expires in <strong>5 minutes</strong>.
            </p>
            ${codeBlock(otp)}
            <p style="margin:0 0 10px 0;font-size:13px;line-height:1.6;color:#475569;">
              If you don't see this email in your inbox, please check your spam/junk folder.
            </p>
            <p style="margin:0 0 18px 0;font-size:13px;line-height:1.6;color:#475569;">
              If you didn't request this, you can safely ignore this email — your ${escapeHtml(what)} will remain unchanged and no action will be taken.
            </p>
            ${securityNote()}
`;

  return wrapEmail({
    heading: `Reset your ${what}`,
    bodyHtml,
    preheader: "Your one-time code expires in 5 minutes.",
    tag: "Security",
    reason: `you requested a ${what} reset for this account`,
  });
};

module.exports = forgotPasswordTemplate;
