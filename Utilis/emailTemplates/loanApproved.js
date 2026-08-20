const loanApprovedTemplate = (
  fullName,
  amount,
  repaymentDate
) => {
  return `
    <div style="font-family:Arial,sans-serif;padding:20px">

      <h2>Congratulations ${fullName},</h2>

      <p>Your loan request has been approved.</p>

      <p><strong>Amount:</strong> ₦${amount}</p>

      <p><strong>Repayment Date:</strong> ${repaymentDate}</p>

      <p>Please log in to your dashboard for more details.</p>

      <br/>

      <p>Socket Moni Team</p>

    </div>
  `;
};

module.exports = loanApprovedTemplate;