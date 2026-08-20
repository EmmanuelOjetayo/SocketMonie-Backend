const transporter = require("./mailer");

const sendEmail = async ({ to, subject, html }) => {
  try {
    const info = await transporter.sendMail({
      from: `"Socket Moni" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });

    console.log("✅ Email sent successfully");
    console.log("Accepted:", info.accepted);
    console.log("Rejected:", info.rejected);

    return {
      success: true,
      message: "Email sent successfully.",
      info,
    };
  } catch (error) {
    console.error("❌ Email sending failed");
    console.error(error);

    return {
      success: false,
      message: error.message,
      error,
    };
  }
};

module.exports = sendEmail;