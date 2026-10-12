const express = require("express");
const { Login, Register, VerifyOtp, ForgotPassword, ResetPassword, Logout } = require("../Controllers/AuthController");
const AuthRoutes = express.Router();
const {AuthValidator} = require("../Middleware/AuthValidate")
const { financialLimiter } = require("../Middleware/rateLimiter");

AuthRoutes.post("/login", financialLimiter, AuthValidator.LoginValidate, Login);
AuthRoutes.post("/register", financialLimiter, AuthValidator.RegisterValidate, Register);
AuthRoutes.post("/verify-otp", financialLimiter, AuthValidator.VerifyOtpValidate, VerifyOtp);
AuthRoutes.post("/forgot-password", financialLimiter, AuthValidator.ForgotPassValidate, ForgotPassword);
AuthRoutes.post("/reset-password", financialLimiter, AuthValidator.ResetPasswordValidate, ResetPassword);
AuthRoutes.post("/logout", Logout);

module.exports = AuthRoutes;