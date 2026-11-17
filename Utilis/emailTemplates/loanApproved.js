const { wrapEmail, detailTable, escapeHtml } = require("./layout");

const loanApprovedTemplate = (
  fullName,
  amount,
  repaymentDate
) => {
  const name = escapeHtml(fullName);

  const bodyHtml = `
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;">Hi ${name},</p>
            <p style="margin:0 0 18px 0;font-size:14px;line-height:1.65;">
              Congratulations — your loan request has been approved.
            </p>
            ${detailTable([
              ["Amount approved", `₦${amount}`],
              ["Repayment date", String(repaymentDate || "—")],
            ])}
            <p style="margin:0 0 18px 0;font-size:13px;line-height:1.6;color:#475569;">
              Please log in to your dashboard to view your repayment schedule and full loan details.
            </p>
`;

  return wrapEmail({
    heading: "Your loan is approved",
    bodyHtml,
    preheader: "Your SocketMonnie loan application has been approved.",
    tag: "Loans",
    reason: "your loan application was processed",
  });
};

module.exports = loanApprovedTemplate;
