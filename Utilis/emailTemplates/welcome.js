const { wrapEmail, securityLine, escapeHtml } = require("./layout");

const welcomeTemplate = (fullName) => {
  const name = escapeHtml(fullName);

  const bodyHtml = `
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;">Hi ${name},</p>
            <p style="margin:0 0 18px 0;font-size:14px;line-height:1.65;">
              Your SocketMonnie account has been successfully verified. Welcome aboard — we're glad to have you as a member.
            </p>
            <p style="margin:0 0 8px 0;font-size:14px;font-weight:700;color:#0f172a;">You can now:</p>
            <ul style="margin:0 0 18px 0;padding-left:20px;font-size:14px;line-height:1.9;color:#334155;">
              <li>Save money toward your goals</li>
              <li>Apply for loans</li>
              <li>Track every transaction</li>
              <li>Manage your cooperative account</li>
            </ul>
            <p style="margin:0 0 18px 0;font-size:13px;line-height:1.6;color:#475569;">
              We're excited to help you save, borrow and grow with your cooperative community.
            </p>
            ${securityLine()}
`;

  return wrapEmail({
    heading: "Welcome to SocketMonnie",
    bodyHtml,
    preheader: "Welcome to SocketMonnie — you're all set to save and grow with your community.",
    tag: "Welcome",
    reason: "you just created a SocketMonnie account",
  });
};

module.exports = welcomeTemplate;
