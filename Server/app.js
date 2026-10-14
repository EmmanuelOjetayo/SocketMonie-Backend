const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const hpp = require("hpp");
const cookieParser = require("cookie-parser");
const mongoSanitize = require("../Middleware/mongoSanitize");
const dns = require("dns");
dns.setServers(['8.8.8.8', '8.8.4.4']);

const { globalLimiter, financialLimiter, adminLimiter } = require("../Middleware/rateLimiter");
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
const recoveryRoutes = require("../Routes/RecoveryRoutes");
const expenseRoutes = require("../Routes/ExpenseRoutes");

// ==========================================================================
// 3. APP CONFIGURATION
// ==========================================================================

const PORT = process.env.PORT || 5000;

const app = express();

// Trust proxy - required for Render/Heroku behind reverse proxy
// Enables express-rate-limit to read X-Forwarded-For header
app.set("trust proxy", 1);

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

  credentials: true,

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
// Flutterwave webhook requests carry the `verif-hash` header; keeping the
// raw body available lets the webhook handler log/debug exact payload bytes.
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

// Parse cookies — must run before auth middleware so req.cookies is available
app.use(cookieParser());

// ==========================================================================
// 7. OTHER SECURITY MIDDLEWARE
// ==========================================================================

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Prevent NoSQL / MongoDB operator injection (e.g. { "$gt": "" } in req.body/query)
app.use(mongoSanitize);

// Global rate limiter: 100 requests per 5 minutes (webhook excluded)
// CORS/preflight is handled BEFORE this middleware.
// Debug endpoint: POST /_debug/reset-ratelimit to reset the store
app.use(globalLimiter);

app.post("/_debug/reset-ratelimit", (req, res) => {
  globalLimiter.store && globalLimiter.store.reset
    ? globalLimiter.store.reset()
    : globalLimiter.store && globalLimiter.store.clear();
  res.json({ success: true, message: "Rate limiter reset" });
});

// Financial endpoints limiter
app.use('/api/loans', financialLimiter);
app.use('/api/savings', financialLimiter);
app.use('/api/payments', financialLimiter);
// Admin endpoints limiter
app.use('/api/admin', adminLimiter);

// ==========================================================================
// 8. API ROUTES
// ==========================================================================

app.use("/api/auth", AuthRoutes);

app.use("/api/user", UserRoutes);

app.use("/api/savings", SavingsRouter);

app.use("/api/reports", reportsRoutes);

app.use("/api/loans", loanRoutes);

app.use("/api/guarantors", guarantorRoutes);

app.use("/api/recovery", recoveryRoutes);

app.use("/api/expenses", expenseRoutes);

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
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
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
  const flwSecretHashConfigured = !!(process.env.FLW_SECRET_HASH || process.env.FLW_WEBHOOK_SECRET);
  if (!flwSecretHashConfigured) {
    console.warn("WARNING: FLW_SECRET_HASH is not configured. Webhook signature verification will fail.");
  }
  res.status(200).json({
    success: true,
    message: "API is healthy",
    flwSecretHashConfigured,
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
  // If headers already sent, delegate to Express default
  if (res.headersSent) {
    return next(err);
  }

  console.error("❌ Server Error:", err.message);
  if (process.env.DEBUG_STACK === "1") console.error(err.stack);

  const statusCode =
    err.statusCode || (res.statusCode && res.statusCode !== 200
      ? res.statusCode
      : 500);

  res.status(statusCode).json({
    success: false,
    message: err.message || "Internal Server Error",
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

    // FALLBACK 2: sweep stale pending payments so missed webhooks reconcile.
    try {
      const { startReconciliationCron } = require("../Utilis/paymentReconciliationCron");
      startReconciliationCron();
    } catch (cronErr) {
      console.error("⚠️  Reconciliation cron failed to start:", cronErr.message);
    }

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

// Prevent transient MongoDB/network errors from crashing the process.
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled Rejection (kept alive):", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught Exception (kept alive):", err?.message || err);
});

// Graceful shutdown on SIGTERM/SIGINT
process.on("SIGTERM", async () => {
  console.info("🛑 SIGTERM received. Shutting down gracefully...");
  try {
    const mongoose = require("mongoose");
    await mongoose.connection.close();
  } catch (e) {
    console.error("Error during shutdown:", e.message);
  } finally {
    process.exit(0);
  }
});

process.on("SIGINT", async () => {
  console.info("🛑 SIGINT received. Shutting down gracefully...");
  try {
    const mongoose = require("mongoose");
    await mongoose.connection.close();
  } catch (e) {
    console.error("Error during shutdown:", e.message);
  } finally {
    process.exit(0);
  }
});

module.exports = app;
