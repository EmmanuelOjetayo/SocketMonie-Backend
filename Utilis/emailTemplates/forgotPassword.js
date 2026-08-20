const forgotPasswordTemplate = (fullName, otp) => {
  return `
    <div style="font-family:Arial,sans-serif;padding:20px">

      <h2>Hello ${fullName},</h2>

      <p>We received a request to reset your password.</p>

      <p>Your OTP is:</p>

      <h1 style="
        letter-spacing:6px;
        color:#dc2626;
      ">
        ${otp}
      </h1>

      <p>This OTP expires in <strong>5 minutes</strong>.</p>

      <p>If you didn't request a password reset, please ignore this email.</p>

      <br/>

      <p>Socket Moni Team</p>

    </div>
  `;
};

module.exports = forgotPasswordTemplate;