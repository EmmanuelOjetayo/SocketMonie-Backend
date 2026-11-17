const { wrapEmail, ctaButton, escapeHtml } = require("./layout");

const guarantorRequestTemplate = (guarantorName, applicantName, verificationLink) => {
  const name = escapeHtml(guarantorName);
  const applicant = escapeHtml(applicantName || "A member");
  const link = escapeHtml(verificationLink);

  const bodyHtml = `
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;">Hi ${name},</p>
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;">
              ${applicant} has asked you to stand as a guarantor for a loan application on SocketMonnie.
            </p>
            <p style="margin:0 0 4px 0;font-size:14px;line-height:1.65;">
              Please review the loan terms and respond using the button below.
            </p>
            ${ctaButton(link, "Review & Respond")}
            <p style="margin:0 0 18px 0;font-size:13px;line-height:1.6;color:#475569;">
              Or paste this link into your browser:<br />
              <a href="${link}" style="color:#3b62ec;text-decoration:none;word-break:break-all;">${link}</a>
            </p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.6;color:#475569;">
              This request link expires in 7 days. If you weren't expecting this request, you can safely ignore this email.
            </div>
`;

  return wrapEmail({
    heading: "Guarantee request",
    bodyHtml,
    preheader: "A member has asked you to stand as guarantor for a loan.",
    tag: "Loans",
    reason: "a member asked you to act as a guarantor",
  });
};

module.exports = guarantorRequestTemplate;
