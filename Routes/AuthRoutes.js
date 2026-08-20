const express = require("express");
const { Login, Register, VerifyOtp, ForgotPassword, ResetPassword } = require("../Controllers/AuthController");
const AuthRoutes = express.Router();
const { strictFinancialLimiter } = require("../Middleware/rateLimiter");

AuthRoutes.post("/login", Login);
AuthRoutes.post("/register", strictFinancialLimiter,  Register);
AuthRoutes.post("/verify-otp",strictFinancialLimiter, VerifyOtp);
AuthRoutes.post("/forgot-password", ForgotPassword);
AuthRoutes.post("/reset-password", ResetPassword);
module.exports = AuthRoutes;