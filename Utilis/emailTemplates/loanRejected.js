const { wrapEmail, escapeHtml } = require("./layout");

const loanRejectedTemplate = (
  fullName,
  reason
) => {
  const name = escapeHtml(fullName);
  const reasonText = escapeHtml(reason || "Not stated");

  const bodyHtml = `
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;">Hi ${name},</p>
            <p style="margin:0 0 18px 0;font-size:14px;line-height:1.65;">
              Unfortunately, your recent loan application was not approved.
            </p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.6;color:#475569;margin:0 0 18px 0;">
              <span style="display:block;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;margin-bottom:6px;">Reason</span>
              ${reasonText}
            </div>
            <p style="margin:0 0 18px 0;font-size:13px;line-height:1.6;color:#475569;">
              You may apply again after meeting the eligibility requirements.
            </p>
`;

  return wrapEmail({
    heading: "Update on your loan application",
    bodyHtml,
    preheader: "An update on your SocketMonnie loan application.",
    tag: "Loans",
    reason: "your loan application was processed",
  });
};

module.exports = loanRejectedTemplate;
