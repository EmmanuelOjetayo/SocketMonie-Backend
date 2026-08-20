const receiptTemplate = (
  fullName,
  amount,
  reference,
  transactionType
) => {
  return `
    <div style="font-family:Arial,sans-serif;padding:20px">

      <h2>Hello ${fullName},</h2>

      <p>Your transaction was successful.</p>

      <table cellpadding="8">
        <tr>
          <td><strong>Transaction</strong></td>
          <td>${transactionType}</td>
        </tr>

        <tr>
          <td><strong>Amount</strong></td>
          <td>₦${amount}</td>
        </tr>

        <tr>
          <td><strong>Reference</strong></td>
          <td>${reference}</td>
        </tr>
      </table>

      <br/>

      <p>Thank you for using Socket Moni.</p>

    </div>
  `;
};

module.exports = receiptTemplate;