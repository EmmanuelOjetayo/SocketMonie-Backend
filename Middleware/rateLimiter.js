const rateLimit = require("express-rate-limit");

// Global Limiter: 50 requests per 5 minutes
const globalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  message: {
    success: false,
    message: "Too many requests from this IP, please try again after 5 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Financial Limiter: 50 requests per 5 minutes
const financialLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  message: {
    success: false,
    message: "Too many financial attempts. Please wait 5 minutes before trying again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin Limiter: 50 requests per 5 minutes for admin operations
const adminLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  message: {
    success: false,
    message: "Too many admin operations. Please wait 5 minutes before trying again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { globalLimiter, financialLimiter, adminLimiter };
