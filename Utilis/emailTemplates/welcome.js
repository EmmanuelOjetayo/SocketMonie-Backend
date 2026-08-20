const welcomeTemplate = (fullName) => {
  return `
    <div style="font-family:Arial,sans-serif;padding:20px">

      <h2>Welcome ${fullName} 🎉</h2>

      <p>Your Socket Moni account has been successfully verified.</p>

      <p>You can now:</p>

      <ul>
        <li>Save money</li>
        <li>Apply for loans</li>
        <li>Track transactions</li>
        <li>Manage your cooperative account</li>
      </ul>

      <p>We're excited to have you onboard.</p>

      <br/>

      <p>Socket Moni Team</p>

    </div>
  `;
};

module.exports = welcomeTemplate;