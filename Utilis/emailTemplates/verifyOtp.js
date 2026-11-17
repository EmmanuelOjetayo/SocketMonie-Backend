const { wrapEmail, codeBlock, securityNote, escapeHtml } = require("./layout");

const verifyOtpTemplate = (fullName, otp) => {
  const name = escapeHtml(fullName);

  const bodyHtml = `
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.65;">Hi ${name},</p>
            <p style="margin:0 0 18px 0;font-size:14px;line-height:1.65;">
              We received a request to create a SocketMonnie account with this email address.
              Enter the code below to verify your email and finish setting up your account.
              For your security, this code expires in <strong>5 minutes</strong>.
            </p>
            ${codeBlock(otp)}
            <p style="margin:0 0 18px 0;font-size:13px;line-height:1.6;color:#475569;">
              If you didn't request this code, you can safely ignore this email — your email address will not be verified and no account will be created.
            </p>
            ${securityNote()}
`;

  return wrapEmail({
    heading: "Verify your email address",
    bodyHtml,
    preheader: "Your one-time verification code expires in 5 minutes.",
    tag: "Verification",
    reason: "someone used this address to create an account on SocketMonnie",
  });
};

module.exports = verifyOtpTemplate;
