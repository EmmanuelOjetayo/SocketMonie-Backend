const express = require("express");
const { Login, Register, VerifyOtp, ForgotPassword, ResetPassword, Logout, IssueCsrf } = require("../Controllers/AuthController");
const AuthRoutes = express.Router();
const {AuthValidator} = require("../Middleware/AuthValidate")
const { financialLimiter } = require("../Middleware/rateLimiter");

// CSRF bootstrap for sessions that never log in (onboarding: register ->
// verify-otp -> KYC). GET is safe (no CSRF check), public, and returns a
// fresh token in the body so the SPA can mirror it into X-CSRF-Token.
AuthRoutes.get("/csrf", IssueCsrf);

AuthRoutes.post("/login", financialLimiter, AuthValidator.LoginValidate, Login);
AuthRoutes.post("/register", financialLimiter, AuthValidator.RegisterValidate, Register);
AuthRoutes.post("/verify-otp", financialLimiter, AuthValidator.VerifyOtpValidate, VerifyOtp);
AuthRoutes.post("/forgot-password", financialLimiter, AuthValidator.ForgotPassValidate, ForgotPassword);
AuthRoutes.post("/reset-password", financialLimiter, AuthValidator.ResetPasswordValidate, ResetPassword);
AuthRoutes.post("/logout", Logout);

module.exports = AuthRoutes;