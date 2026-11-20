const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const hpp = require("hpp");
const cookieParser = require("cookie-parser");
const mongoSanitize = require("../Middleware/mongoSanitize");
const { configureMongoDns } = require("../Utilis/mongoAtlas");
configureMongoDns();

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
const MembershipRoutes = require("../Routes/MembershipRoutes");
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
const transactionRoutes = require("../Routes/TransactionRoutes");
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
  "https://socketmonnie-frontend.onrender.com", //current in use
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
    "X-CSRF-Token",
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
// 7. REQUEST LOGGING (Morgan "dev") — logs method, URL, HTTP status and
// response time on every request (dev format gives colour-coding: green 2xx,
// yellow 4xx, red 5xx+). Morgan never includes request bodies, cookies or
// auth headers, so OTPs/passwords/tokens cannot leak through it.
// Health check + root ping are skipped to avoid log noise. The global error
// handler below still logs every 4xx/5xx error message in full.
// ==========================================================================
const morgan = require("morgan");
app.use(
  morgan("dev", {
    skip: (req) => req.path === "/api/health" || req.path === "/",
  })
);

// ==========================================================================
// 7. OTHER SECURITY MIDDLEWARE
// ==========================================================================

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Prevent NoSQL / MongoDB operator injection (e.g. { "$gt": "" } in req.body/query)
app.use(mongoSanitize);

// CSRF protection for state-changing requests (double-submit token + origin
// allowlist). Must run after cookieParser so req.cookies is available.
const { csrfProtect } = require("../Middleware/csrfProtect");
app.use(csrfProtect);

// Global rate limiter: requests per window (webhook excluded).
// CORS/preflight is handled BEFORE this middleware.
app.use(globalLimiter);

// Test/dev-only hook to clear rate-limit buckets for automated suites.
// Disabled in production to prevent brute-force/rate-limit bypass.
app.post("/_debug/reset-ratelimit", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ success: false, message: "Not found" });
  }
  const key = req.ip;
  const limiters = [globalLimiter, financialLimiter, adminLimiter];
  const reset = limiters.map((limiter) => {
    try {
      if (typeof limiter.resetKey === "function") {
        limiter.resetKey(key);
        return true;
      }
    } catch (_) {
      /* limiter without a resettable key — skip */
    }
    return false;
  });
  res.json({ success: true, message: "Rate limiter reset", key, reset });
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
app.use("/api/membership", MembershipRoutes);

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

app.use("/api/transactions", transactionRoutes);

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
  const flwSecretHashConfigured = !!(process.env.FLW_SECRET_HASH || process.env.FLW_WEBHOOK_SECRET);
  if (!flwSecretHashConfigured) {
    // Never crash the process on a health probe; surface the misconfiguration so
    // operators can alert on it without turning a single bad deploy into a DoS.
    console.error("❌ CRITICAL: FLW_SECRET_HASH is not configured. Webhook signature verification cannot run until it is set.");
  }
  // Report only the Flutterwave credential MODE (test/live), never values.
  // A public/secret mode mismatch silently degrades Inline checkout to the
  // sandbox mock flow (MockFLWRef) — surface it here so deploys are provable.
  const pub = String(process.env.FLW_PUBLIC_KEY || process.env.FLWPUBK || "");
  const sec = String(process.env.FLW_SECRET_KEY || process.env.FLWSECK || "");
  const pubTest = /_TEST/i.test(pub);
  const secTest = /_TEST/i.test(sec);
  res.status(flwSecretHashConfigured ? 200 : 503).json({
    success: flwSecretHashConfigured,
    message: flwSecretHashConfigured ? "API is healthy" : "API running but FLW webhook secret hash is not configured",
    flwSecretHashConfigured,
    flutterwave: {
      publicKeyMode: pubTest ? "test" : pub ? "live" : "missing",
      secretKeyMode: secTest ? "test" : sec ? "live" : "missing",
      keysConsistent: (pubTest && secTest) || (!pubTest && !secTest),
    },
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

    // Webhook-only confirmation: the former stale-payment reconciliation cron
    // is intentionally NOT started. A pending payment stays pending until the
    // signed Flutterwave webhook establishes its final state.

    // SocketScore: finalize last month's CGPA-style scores on the 1st.
    try {
      const { startSocketScoreCron } = require("../Utilis/socketScoreCron");
      startSocketScoreCron();
    } catch (cronErr) {
      console.error("⚠️  SocketScore cron failed to start:", cronErr.message);
    }

    // Loan defaulter escalation: advance overdue → warning → default → restricted
    // → recovery. Idempotent, daily (03:00). Never auto-deducts funds.
    try {
      const { startLoanDefaulterCron } = require("../Utilis/loanDefaulterCron");
      startLoanDefaulterCron();
    } catch (cronErr) {
      console.error("⚠️  Loan defaulter cron failed to start:", cronErr.message);
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
