const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const hpp = require("hpp");
// const mongoSanitize = require("../Middleware/mongoSanitize");
const dns = require("dns");
dns.setServers(['8.8.8.8', '8.8.4.4']);

const { globalLimiter } = require("../Middleware/rateLimiter");
const db = require("../Config/db");

// ==========================================================================
// 1. LOAD ENVIRONMENT VARIABLES
// ==========================================================================

dotenv.config({
  path: path.join(__dirname, "../.env"),
});

// ==========================================================================
// 2. ROUTE IMPORTS
// ==========================================================================

const AuthRoutes = require("../Routes/AuthRoutes");
const UserRoutes = require("../Routes/UserRoutes");
const SavingsRouter = require("../Routes/SavingsRoute");
const reportsRoutes = require("../Routes/reportsRoutes");
const loanRoutes = require("../Routes/LoanRoutes");
const notificationRoutes = require("../Routes/NotificationRoutes");
const complaintRoutes = require("../Routes/ComplaintRoutes");
const adminRoutes = require("../Routes/AdminRoutes");
const financeRoutes = require("../Routes/FinanceRoutes");
const supportRoutes = require("../Routes/SupportRoutes");
const referralRoutes = require("../Routes/ReferralRoutes");
const scoreRoutes = require("../Routes/ScoreRoutes");
const tierRoutes = require("../Routes/TierRoutes");
const paymentRoutes = require("../Routes/PaymentRoutes");
const systemSettingsRoutes = require("../Routes/SystemSettingsRoutes");
const guarantorRoutes = require("../Routes/GuarantorRoutes");

// ==========================================================================
// 3. APP CONFIGURATION
// ==========================================================================

const PORT = process.env.PORT || 5000;

const app = express();

// ==========================================================================
// 4. CORS CONFIGURATION
// ==========================================================================

const allowedOrigins = [
  "https://socketmonnie.netlify.app",
  "https://socketmonnie.onrender.com",
  "http://localhost:5173",
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests without an Origin header
    // e.g. Postman, server-to-server requests, etc.
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log(`❌ CORS blocked origin: ${origin}`);

    return callback(
      new Error(`CORS policy violation: ${origin} is not allowed`)
    );
  },

  // credentials: true,

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
  ],

  optionsSuccessStatus: 204,
};

// ==========================================================================
// 5. GLOBAL SECURITY & PERFORMANCE MIDDLEWARE
// ==========================================================================

// Security headers
app.use(helmet());

// Compress HTTP responses
app.use(compression());

// CORS
// IMPORTANT: This must come before the routes and rate limiter.
app.use(cors(corsOptions));


// ==========================================================================
// 6. BODY PARSERS
// ==========================================================================

// Capture the raw request body bytes as they arrive, BEFORE JSON parsing.
// Paystack webhook signatures are an HMAC-SHA512 of the exact raw body —
// re-serializing req.body with JSON.stringify() after parsing does NOT
// reliably reproduce the same bytes (key order, spacing, unicode escaping
// can all differ), so the raw buffer must be preserved for verification.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(
  express.urlencoded({
    extended: false,
  })
);

// ==========================================================================
// 7. OTHER SECURITY MIDDLEWARE
// ==========================================================================

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Prevent NoSQL / MongoDB operator injection (e.g. { "$gt": "" } in req.body/query)
// app.use(mongoSanitize());

// Global rate limiter
// CORS/preflight is handled BEFORE this middleware.
app.use(globalLimiter);

// ==========================================================================
// 8. API ROUTES
// ==========================================================================

app.use("/api/auth", AuthRoutes);

app.use("/api/user", UserRoutes);

app.use("/api/savings", SavingsRouter);

app.use("/api/reports", reportsRoutes);

app.use("/api/loans", loanRoutes);

app.use("/api/guarantors", guarantorRoutes);

app.use("/api/notifications", notificationRoutes);

app.use("/api/complaints", complaintRoutes);

app.use("/api/admin", adminRoutes);

app.use("/api/finance", financeRoutes);

app.use("/api/support", supportRoutes);

app.use("/api/referrals", referralRoutes);

app.use("/api/scores", scoreRoutes);

app.use("/api/tier", tierRoutes);

app.use("/api/payments", paymentRoutes);

app.use("/api/settings", systemSettingsRoutes);

// ==========================================================================
// 9. HEALTH CHECK
// ==========================================================================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "SocketMonie API is running 🚀",
    environment: process.env.NODE_ENV || "development",
  });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "API is healthy",
  });
});

// ==========================================================================
// 10. 404 HANDLER
// ==========================================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

// ==========================================================================
// 11. GLOBAL ERROR HANDLER
// ==========================================================================

app.use((err, req, res, next) => {
  console.error("❌ Server Error:", err);

  const statusCode =
    res.statusCode && res.statusCode !== 200
      ? res.statusCode
      : 500;

  res.status(statusCode).json({
    success: false,
    message: err.message || "Internal Server Error",

    // Only expose stack traces during development
    stack:
      process.env.NODE_ENV === "production"
        ? null
        : err.stack,
  });
});

// ==========================================================================
// 12. DATABASE & SERVER BOOTSTRAP
// ==========================================================================

const startServer = async () => {
  try {
    await db();

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(`🔐 CORS enabled for:`);
      allowedOrigins.forEach((origin) => {
        console.log(`   - ${origin}`);
      });
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

startServer();

module.exports = app;
