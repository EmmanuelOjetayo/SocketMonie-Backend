const { AuthService } = require("../Services/AuthService.js");

const cookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 1000, // 1 hour
};

const Login = async (req, res, next) => {
  try {
    const result = await AuthService.LoginService(req.body);

    res.cookie("socketmoni_token", result.token, cookieOptions);

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      data: { user: result.user },
    });
  } catch (error) { next(error); }
};

const Register = async (req, res, next) => {
  try {
    const response = await AuthService.RegisterService(req.body);

    return res.status(201).json({
      success: true,
      message: "Account created successfully. Please verify your email.",
      data: response,
    });
  } catch (error) { next(error); }
};

const VerifyOtp = async (req, res, next) => {
  try {
    const result = await AuthService.VerifyOTPService(req.body);

    res.cookie("socketmoni_token", result.token, cookieOptions);

    return res.status(200).json({
      success: true,
      message: "Account verified successfully.",
      data: { user: result.user, verified: result.verified },
    });
  } catch (error) { next(error); }
};

const ForgotPassword = async (req, res, next) => {
  try {
    const result = await AuthService.ForgotPasswordService(req.body);

    result.success ? res.status(200).json({ success: true, message: "Password reset OTP sent to your email." }) : res.status(400).json({ success: false, message: "Invalid OTP." });
  } catch (error) { next(error); }
};

const ResetPassword = async (req, res, next) => {
  try {
    await AuthService.ResetPasswordService(req.body);
    return res.status(200).json({ success: true, message: "Password reset successful. Please log in." });
  } catch (error) { next(error); }
};

const Logout = async (req, res, next) => {
  try {
    res.clearCookie("socketmoni_token", {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    });
    return res.status(200).json({ success: true, message: "Logged out successfully." });
  } catch (error) { next(error); }
};

module.exports = { Login, Register, VerifyOtp, ForgotPassword, ResetPassword, Logout };
