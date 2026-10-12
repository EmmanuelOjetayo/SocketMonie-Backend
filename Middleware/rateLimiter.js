const rateLimit = require("express-rate-limit");

// Flutterwave sends webhooks server-to-server from their own IPs.
// Exempt the webhook path from ALL rate limiters so payment events
// are never dropped due to rate limiting.
const isWebhook = (req) =>
  req.path === "/api/payments/webhook" ||
  req.path === "/payments/webhook" ||
  req.originalUrl?.includes("/payments/webhook");

// Global Limiter: 50 requests per 5 minutes (webhook excluded)
const globalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  skip: isWebhook,
  message: {
    success: false,
    message: "Too many requests from this IP, please try again after 5 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Financial Limiter: 50 requests per 5 minutes (webhook excluded)
const financialLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 50,
  skip: isWebhook,
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
