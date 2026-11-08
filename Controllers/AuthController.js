const { AuthService } = require("../Services/AuthService.js");

const isProduction = process.env.NODE_ENV === "production";

// sameSite: "none" is REQUIRED for cross-origin (Netlify → Render).
// "strict" blocks the cookie from ever being sent on cross-origin requests,
// which causes 401 on every page refresh.
const cookieOptions = {
  httpOnly: true,
  sameSite: isProduction ? "none" : "lax",
  secure: isProduction,
  maxAge: 60 * 60 * 1000, // 1 hour
};

// CSRF token uses the same cross-site posture but must be JS-readable
// (double-submit pattern — the SPA mirrors it into the X-CSRF-Token header).
const { issueCsrfCookie } = require("../Middleware/csrfProtect");

const Login = async (req, res, next) => {
  try {
    const result = await AuthService.LoginService(req.body);

    res.cookie("socketmoni_token", result.token, cookieOptions);
    const csrfToken = issueCsrfCookie(res);

    return res.status(200).json({
      success: true,
      message: "Login successful.",
      data: { user: result.user, csrfToken },
    });
  } catch (error) { next(error); }
};

const Register = async (req, res, next) => {
  try {
    const response = await AuthService.RegisterService(req.body);

    // Onboarding starts here WITHOUT a login, so this is the earliest point
    // a session can obtain a CSRF token. Issue the double-submit cookie AND
    // echo the token in the body so the SPA caches it (cross-origin deploys
    // can never read the backend-scoped cookie via document.cookie).
    const csrfToken = issueCsrfCookie(res);

    return res.status(201).json({
      success: true,
      message: "Account created successfully. Please verify your email.",
      data: { ...response, csrfToken },
    });
  } catch (error) { next(error); }
};

const VerifyOtp = async (req, res, next) => {
  try {
    const result = await AuthService.VerifyOTPService(req.body);

    res.cookie("socketmoni_token", result.token, cookieOptions);
    const csrfToken = issueCsrfCookie(res);

    return res.status(200).json({
      success: true,
      message: "Account verified successfully.",
      data: { user: result.user, verified: result.verified, csrfToken },
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
      sameSite: isProduction ? "none" : "lax",
      secure: isProduction,
    });
    return res.status(200).json({ success: true, message: "Logged out successfully." });
  } catch (error) { next(error); }
};

/**
 * CSRF token bootstrap — GET /api/auth/csrf
 *
 * Public, safe, and credential-independent: sessions that NEVER log in
 * (the register -> verify-otp -> KYC onboarding path) still need a valid
 * double-submit token before their first POST / PATCH / FormData upload
 * (/api/user/personal-info, /api/user/kyc, ...). Without this bootstrap
 * those requests fail with CSRF_TOKEN_INVALID while dashboard actions
 * (post-login) keep working — the exact production symptom observed.
 *
 * Issues a fresh token, sets the JS-readable csrfToken cookie (SameSite
 * posture identical to the auth cookies) AND echoes the token in the body,
 * which is the only reliable channel on cross-origin deployments
 * (Netlify -> Render) where document.cookie cannot read the
 * backend-scoped cookie.
 */
const IssueCsrf = async (req, res, next) => {
  try {
    const csrfToken = issueCsrfCookie(res);
    return res.status(200).json({ success: true, csrfToken });
  } catch (error) { next(error); }
};

module.exports = { Login, Register, VerifyOtp, ForgotPassword, ResetPassword, Logout, IssueCsrf };
