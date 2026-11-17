const { wrapEmail, detailTable, escapeHtml } = require("./layout");

const receiptTemplate = (
  fullName,
  amount,
  reference,
  transactionType
) => {
  const name = escapeHtml(fullName);

  const bodyHtml = `
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;">Hi ${name},</p>
            <p style="margin:0 0 18px 0;font-size:14px;line-height:1.65;">
              Your transaction was successful. Here's your receipt — please keep it for your records.
            </p>
            ${detailTable([
              ["Transaction", String(transactionType || "—")],
              ["Amount", `₦${amount}`],
              ["Reference", String(reference || "—")],
            ])}
            <p style="margin:0 0 18px 0;font-size:13px;line-height:1.6;color:#475569;">
              If you didn't authorise this transaction, contact support immediately.
            </p>
`;

  return wrapEmail({
    heading: "Transaction successful",
    bodyHtml,
    preheader: "Your SocketMonnie transaction receipt.",
    tag: "Receipt",
    reason: "a transaction was completed on your account",
  });
};

module.exports = receiptTemplate;
