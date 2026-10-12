const express = require("express");
const { Login, Register, VerifyOtp, ForgotPassword, ResetPassword, Logout } = require("../Controllers/AuthController");
const AuthRoutes = express.Router();
const {AuthValidator} = require("../Middleware/AuthValidate")
const { strictFinancialLimiter } = require("../Middleware/rateLimiter");

AuthRoutes.post("/login", strictFinancialLimiter, AuthValidator.LoginValidate, Login);
AuthRoutes.post("/register", strictFinancialLimiter, AuthValidator.RegisterValidate, Register);
AuthRoutes.post("/verify-otp",strictFinancialLimiter, AuthValidator.VerifyOtpValidate, VerifyOtp);
AuthRoutes.post("/forgot-password", strictFinancialLimiter, AuthValidator.ForgotPassValidate, ForgotPassword);
AuthRoutes.post("/reset-password", strictFinancialLimiter, AuthValidator.ResetPasswordValidate, ResetPassword);
AuthRoutes.post("/logout", Logout);

module.exports = AuthRoutes;