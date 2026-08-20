const loanRejectedTemplate = (
  fullName,
  reason
) => {
  return `
    <div style="font-family:Arial,sans-serif;padding:20px">

      <h2>Hello ${fullName},</h2>

      <p>Unfortunately, your recent loan application was not approved.</p>

      <p><strong>Reason:</strong></p>

      <p>${reason}</p>

      <p>You may apply again after meeting the eligibility requirements.</p>

      <br/>

      <p>Socket Moni Team</p>

    </div>
  `;
};

module.exports = loanRejectedTemplate;