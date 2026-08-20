const rateLimit = require("express-rate-limit");

// Standard Global Limiter: 100 requests per 15 minutes
const globalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, 
  max: 1000,
  message: {
    success: false,
    message: "Too many requests from this IP, please try again after 15 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict Limiter for Auth & Financial Actions: 10 requests per 15 minutes
const strictFinancialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: "Too many financial attempts. Please wait 15 minutes before trying again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { globalLimiter, strictFinancialLimiter };