const { wrapEmail } = require("./layout");

const guarantorRequestTemplate = (guarantorName, applicantName, verificationLink) => {
  return wrapEmail({
    heading: `Hello ${guarantorName},`,
    bodyHtml: `
      <p>${applicantName || "A member"} has requested you to stand as a guarantor for their loan application on Socket Moni.</p>
      <p>Please review the loan terms and respond using the button below.</p>
      <p style="text-align:center;">
        <a class="cta" href="${verificationLink}">Review &amp; Respond</a>
      </p>
      <p>Or paste this link into your browser:</p>
      <p><a href="${verificationLink}">${verificationLink}</a></p>
      <div class="note">
        This request link will expire in 7 days. If you were not expecting this request, you can safely ignore this email.
      </div>
    `,
  });
};

module.exports = guarantorRequestTemplate;
