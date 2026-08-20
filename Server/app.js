const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const mongoSanitize = require("express-mongo-sanitize");
const hpp = require("hpp");
const { globalLimiter } = require("../Middleware/rateLimiter");
const dns = require("dns");
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);
// Load Environment Variables first
dotenv.config({ path: path.join(__dirname, "../.env") });

const db = require("../Config/db");
// Route Imports
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
const guarantorRoutes = require("../Routes/GuarantorRoutes"); // Phase 4 Route

const PORT = process.env.PORT || 5000;
const app = express();

// ==========================================================================
// 1. GLOBAL SECURITY & PERFORMANCE MIDDLEWARE
// ==========================================================================

// Security Headers
app.use(helmet());

// Compress all HTTP response bodies (Gzip)
app.use(compression());

// Strict CORS Configuration
// const allowedOrigins = [
//   "http://localhost:5173",
//   "https://www.socketmoni.render.com",
//   "https://socketmoni.render.com",
// ];
app.use(cors());
// app.use(
//   cors({
//     origin: (origin, callback) => {
//       // Allow requests with no origin (e.g. Mobile Apps, Postman, server-to-server)
//       if (!origin || allowedOrigins.includes(origin)) {
//         callback(null, true);
//       } else {
//         callback(new Error("CORS policy violation: Access denied"));
//       }
//     },
//     credentials: true,
//     methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//   })
// );

// Body Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// // Sanitize inputs against NoSQL Injection ($where, $gt, etc.)
// app.use(mongoSanitize());

// Prevent HTTP Parameter Pollution
app.use(hpp());
app.use(globalLimiter);

// ==========================================================================
// 2. API ROUTES
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
// 3. GLOBAL ERROR HANDLER
// ==========================================================================
app.use((err, req, res, next) => {
  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  res.status(statusCode).json({
    success: false,
    message: err.message,
    stack: process.env.NODE_ENV === "production" ? null : err.stack,
  });
});

// ==========================================================================
// 4. DATABASE & SERVER BOOTSTRAP
// ==========================================================================
db()

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});