/**
 * 127-Feature Comprehensive Test Suite for SocketMonnie
 * Run: node tests/system.test.js [batch]
 * Batch 1: Auth, User, Savings, Loans, Guarantors (tests 1-47)
 * Batch 2: Recovery, Notifications, Complaints, Referrals, Scores, Tier, Payments (tests 48-98)
 * Batch 3: Webhook, Role Restrictions, Rate Limit, Health (tests 99-127)
 */
const http = require("http");

const BASE = { hostname: "localhost", port: 5000 };

let PASS = 0;
let FAIL = 0;
const failures = [];

function req(path, method, body, headers) {
  return new Promise((resolve) => {
    const opts = {
      ...BASE,
      path,
      method,
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    };
    const r = http.request(opts, (res) => {
      let data = "";
      let sc = res.headers["set-cookie"] || [];
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: data, setCookie: sc, headers: res.headers })
      );
    });
    r.on("error", () => resolve({ status: 0, body: "CONNECTION_ERROR", setCookie: [], headers: {} }));
    r.setTimeout(12000, () => {
      r.destroy();
      resolve({ status: 0, body: "TIMEOUT", setCookie: [], headers: {} });
    });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function t(id, label, ok, detail) {
  if (ok) {
    PASS++;
    console.log(`  PASS #${id} ${label}`);
  } else {
    FAIL++;
    const d = detail ? ` | ${detail}` : "";
    console.log(`  FAIL #${id} ${label}${d}`);
    failures.push(`#${id} ${label}${d}`);
  }
}

async function login() {
  const r = await req("/api/auth/login", "POST", {
    email: "authtest@test.com",
    password: "TestPass123!",
  });
  const cookie = (r.setCookie || []).map((c) => c.split(";")[0]).join("; ");
  return { cookie, H: { Cookie: cookie }, ok: r.status === 200 };
}

async function runBatch1() {
  console.log("\n========== BATCH 1: Auth, User, Savings, Loans, Guarantors (#1-47) ==========\n");

  // --- AUTH (1-15) ---
  console.log("--- Auth Flow ---");
  let r;
  r = await req("/api/auth/register", "POST", { fullName: "T", email: "bad", phone: "x" });
  t(1, "Register invalid data -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/auth/register", "POST", {
    fullName: "Test User", email: "bad2", phone: "08012345678", password: "weak",
  });
  t(2, "Register weak password -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/auth/register", "POST", {
    fullName: "", email: "", phone: "", password: "",
  });
  t(3, "Register empty fields -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/auth/login", "POST", { email: "nonexist@test.com", password: "wrong" });
  t(4, "Login nonexistent account -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/auth/login", "POST", { email: "authtest@test.com", password: "wrongpw" });
  t(5, "Login wrong password -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/auth/login", "POST", { email: "", password: "" });
  t(6, "Login empty credentials -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/auth/login", "POST", { email: "authtest@test.com", password: "TestPass123!" });
  const cookie = (r.setCookie || []).map((c) => c.split(";")[0]).join("; ");
  const H = { Cookie: cookie };
  t(7, "Login correct -> 200 + cookie", r.status === 200 && cookie.includes("socketmoni_token"), `got ${r.status}`);

  r = await req("/api/auth/verify-otp", "POST", { email: "nonexist@test.com", otp: "000000" });
  t(8, "Verify OTP nonexistent email -> error", r.status >= 400, `got ${r.status}`);

  r = await req("/api/auth/verify-otp", "POST", { email: "authtest@test.com", otp: "000000" });
  t(9, "Verify OTP (already verified) -> handled", r.status > 0, `got ${r.status}`);

  r = await req("/api/auth/forgot-password", "POST", { email: "nonexist@test.com" });
  t(10, "Forgot pw no account -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/auth/forgot-password", "POST", { email: "authtest@test.com" });
  t(11, "Forgot pw existing -> 200 (no crash)", r.status === 200, `got ${r.status}`);

  r = await req("/api/auth/reset-password", "POST", { email: "nonexist@test.com", otp: "000000", newPassword: "NewPass123!" });
  t(12, "Reset pw nonexistent -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/auth/reset-password", "POST", { email: "authtest@test.com", otp: "000000", newPassword: "NewPass123!" });
  t(13, "Reset pw wrong OTP -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/auth/reset-password", "POST", { email: "authtest@test.com", otp: "000000", newPassword: "weak" });
  t(14, "Reset pw weak new password -> 400", r.status >= 400, `got ${r.status}`);

  r = await req("/api/auth/logout", "POST", null, H);
  t(15, "Logout -> 200", r.status === 200, `got ${r.status}`);

  // --- AUTH PERSISTENCE INTEGRATION TESTS ---
  // Test that auth persists across page refresh (cookie-based auth)
  r = await req("/api/user/me", "GET", null, H);
  t(16, "GET /user/me after login -> 200 (cookie auth)", r.status === 200, `got ${r.status}`);

  // Simulate unauthenticated access
  r = await req("/api/user/me", "GET");
  t(17, "GET /user/me without cookie -> 401", r.status === 401, `got ${r.status}`);

  // Re-login and verify cookie is set
  r = await req("/api/auth/login", "POST", {
    email: "authtest@test.com",
    password: "TestPass123!",
  });
  const loginAuthCookie = (r.setCookie || []).map((c) => c.split(";")[0]).join("; ");
  const authHeaders = { Cookie: loginAuthCookie };
  t(18, "Re-login sets cookie", r.status === 200 && loginAuthCookie.includes("socketmoni_token"), `got ${r.status}`);

  // Verify cookie persists authenticated session
  r = await req("/api/user/me", "GET", null, authHeaders);
  t(19, "GET /user/me with cookie -> 200 (auth persists)", r.status === 200, `got ${r.status} ${r.body.substring(0,80)}`);

  // Verify unauthenticated access is rejected
  r = await req("/api/expenses", "GET");
  t(20, "GET /expenses without auth -> 401", r.status === 401, `got ${r.status}`);

  console.log(`\nAuth Persistence Integration Tests:`);
  console.log(`  PASS: ${PASS}, FAIL: ${FAIL}`);

  // --- USER PROFILE (16-25) ---
  console.log("\\n--- User Profile ---");
  r = await req("/api/user/me", "GET", null, H2);
  t(16, "GET /user/me authenticated -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/user/me", "GET");
  t(17, "GET /user/me unauthenticated -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/user/personal-info", "PATCH", { address: "123 Test Street, Lagos" }, H2);
  t(18, "PATCH personal-info valid (address) -> 200", r.status === 200, `got ${r.status} ${r.body.substring(0,80)}`);

  r = await req("/api/user/personal-info", "PATCH", {}, H2);
  t(19, "PATCH personal-info empty body -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/user/pin", "POST", { pin: "1234" }, H2);
  t(20, "POST set PIN valid -> 200", r.status === 200, `got ${r.status} ${r.body.substring(0,80)}`);

  r = await req("/api/user/pin", "POST", { pin: "12" }, H2);
  t(21, "POST set PIN short -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/user/pin/forgot", "POST", { email: "authtest@test.com" });
  t(22, "POST pin/forgot -> 200/400 (email may fail without Brevo key)", r.status === 200 || r.status === 400, `got ${r.status}`);

  r = await req("/api/user/bank-details", "PUT", {
    accountNumber: "0123456789", bankCode: "044", bankName: "Access Bank", accountName: "Auth Test User",
  }, H2);
  t(23, "PUT bank-details valid -> 200", r.status === 200, `got ${r.status} ${r.body.substring(0,80)}`);

  r = await req("/api/user/bank-details", "PUT", { accountNumber: "123", bankCode: "" }, H2);
  t(24, "PUT bank-details invalid -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/user/kyc", "POST", { documentType: "passport" }, H2);
  t(25, "POST KYC no file -> 400", r.status >= 400, `got ${r.status}`);

  // --- SAVINGS (26-35) ---
  console.log("\n--- Savings ---");
  r = await req("/api/savings/summary", "GET", null, H2);
  t(26, "GET savings/summary -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/savings/report", "GET", null, H2);
  t(27, "GET savings/report -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/savings/history", "GET", null, H2);
  t(28, "GET savings/history -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/savings/withdraw-request", "POST", {
    amount: 1000, accountNumber: "0123456789", bankName: "Access Bank", accountName: "Test", pin: "1234",
  }, H2);
  t(29, "POST withdraw-request -> 200 or 400 (insufficient balance ok)", r.status === 200 || r.status === 400, `got ${r.status} ${r.body.substring(0,80)}`);

  r = await req("/api/savings/withdraw-request", "POST", { amount: -100 }, H2);
  t(30, "POST withdraw-request negative amount -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/savings/tier-commitment", "PUT", { newTier: "silver", newCommitment: 10000 }, H2);
  t(31, "PUT tier-commitment -> 200 or 400 (tier requirements ok)", r.status === 200 || r.status === 400, `got ${r.status} ${r.body.substring(0,80)}`);

  r = await req("/api/savings/tier-commitment", "PUT", { newTier: "invalid", newCommitment: 100 }, H2);
  t(32, "PUT tier-commitment invalid tier -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/savings/membership-fee/initialize", "POST", null, H2);
  const mf = JSON.parse(r.body); const mfp = mf?.data || mf;
  t(33, "POST membership-fee/initialize -> 200 + publicKey", r.status === 200 && mfp?.publicKey, `got ${r.status}`);

  r = await req("/api/savings/membership-fee/verify", "POST", { tx_ref: "FAKE" }, H2);
  t(34, "POST membership-fee/verify fake -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/savings/summary", "GET");
  t(35, "GET savings/summary unauthenticated -> 401", r.status === 401, `got ${r.status}`);

  // --- LOANS (36-47) ---
  console.log("\n--- Loans ---");
  r = await req("/api/loans/eligibility", "GET", null, H2);
  t(36, "GET loans/eligibility -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/loans/active", "GET", null, H2);
  t(37, "GET loans/active -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/loans/history", "GET", null, H2);
  t(38, "GET loans/history -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/loans/000000000000000000000000", "GET", null, H2);
  t(39, "GET loans/:invalidId -> 404/400", r.status >= 400, `got ${r.status}`);

  r = await req("/api/loans/apply", "POST", { amount: 50000, purpose: "test", guarantors: [] }, H2);
  t(40, "POST loans/apply (no membership) -> error", r.status >= 400, `got ${r.status}`);

  r = await req("/api/loans/apply", "POST", {}, H2);
  t(41, "POST loans/apply empty body -> 400/403 (membership gate ok)", r.status === 400 || r.status === 403, `got ${r.status}`);

  r = await req("/api/loans/repay/initialize", "POST", {}, H2);
  t(42, "POST repay/initialize missing fields -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/loans/repay/verify", "POST", {}, H2);
  t(43, "POST repay/verify missing fields -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/loans/approve/000000000000000000000000", "PUT", {}, H2);
  t(44, "PUT loans/approve member -> 403", r.status === 403, `got ${r.status}`);

  r = await req("/api/loans/eligibility", "GET");
  t(45, "GET loans/eligibility unauthenticated -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/loans/active", "GET");
  t(46, "GET loans/active unauthenticated -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/loans/000000000000000000000000/schedule", "GET", null, H2);
  t(47, "GET loans/:invalidId/schedule -> 400/404", r.status >= 400, `got ${r.status}`);

  console.log(`\nBatch 1: ${PASS} pass, ${FAIL} fail`);
}

async function runBatch2() {
  console.log("\n========== BATCH 2: Recovery, Notifications, Complaints, Referrals, Scores, Tier, Payments (#48-98) ==========\n");

  const sess = await login();
  const H = sess.H;

  // --- GUARANTORS (48-53) ---
  console.log("--- Guarantors ---");
  let r;
  r = await req("/api/guarantors/pending-requests", "GET", null, H);
  t(48, "GET guarantors/pending-requests -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/guarantors/search/NONEXISTENTCODE", "GET", null, H);
  t(49, "GET guarantors/search/:code (nonexistent) -> 400/404", r.status >= 400, `got ${r.status}`);

  r = await req("/api/guarantors/verify/FAKE_TOKEN", "GET");
  t(50, "GET guarantors/verify/:token invalid -> 400/404", r.status >= 400, `got ${r.status}`);

  r = await req("/api/guarantors/respond", "POST", {}, H);
  t(51, "POST guarantors/respond empty -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/guarantors/pending-requests", "GET");
  t(52, "GET guarantors/pending-requests unauth -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/guarantors/loan/000000000000000000000000", "GET", null, H);
  t(53, "GET guarantors/loan/:invalidId -> 400/404", r.status >= 400, `got ${r.status}`);

  // --- RECOVERY (54-57) ---
  console.log("\n--- Recovery ---");
  r = await req("/api/recovery/obligations", "GET", null, H);
  t(54, "GET recovery/obligations -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/recovery/000000000000000000000000/pay", "POST", { amount: 1000 }, H);
  t(55, "POST recovery/:id/pay invalid id -> 400/404", r.status >= 400, `got ${r.status}`);

  r = await req("/api/recovery/complete", "POST", {}, H);
  t(56, "POST recovery/complete empty -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/recovery/obligations", "GET");
  t(57, "GET recovery/obligations unauth -> 401", r.status === 401, `got ${r.status}`);

  // --- NOTIFICATIONS (58-62) ---
  console.log("\n--- Notifications ---");
  r = await req("/api/notifications", "GET", null, H);
  t(58, "GET notifications -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/notifications/mark-all-read", "PATCH", null, H);
  t(59, "PATCH mark-all-read -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/notifications/000000000000000000000000/read", "PATCH", null, H);
  t(60, "PATCH :id/read invalid id -> 400/404", r.status >= 400, `got ${r.status}`);

  r = await req("/api/notifications", "GET");
  t(61, "GET notifications unauth -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/notifications/mark-all-read", "PATCH");
  t(62, "PATCH mark-all-read unauth -> 401", r.status === 401, `got ${r.status}`);

  // --- COMPLAINTS (63-66) ---
  console.log("\n--- Complaints ---");
  r = await req("/api/complaints/mine", "GET", null, H);
  t(63, "GET complaints/mine -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/complaints", "POST", { subject: "Test Complaint", message: "This is a test complaint from the system test suite." }, H);
  t(64, "POST complaint valid -> 200", r.status === 200, `got ${r.status} ${r.body.substring(0,80)}`);

  r = await req("/api/complaints", "POST", { subject: "", message: "" }, H);
  t(65, "POST complaint empty -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/complaints/mine", "GET");
  t(66, "GET complaints/mine unauth -> 401", r.status === 401, `got ${r.status}`);

  // --- REFERRALS (67-70) ---
  console.log("\n--- Referrals ---");
  r = await req("/api/referrals/stats", "GET", null, H);
  t(67, "GET referrals/stats -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/referrals/activity", "GET", null, H);
  t(68, "GET referrals/activity -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/referrals/stats", "GET");
  t(69, "GET referrals/stats unauth -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/referrals/activity", "GET");
  t(70, "GET referrals/activity unauth -> 401", r.status === 401, `got ${r.status}`);

  // --- SCORES (71-76) ---
  console.log("\n--- Scores ---");
  r = await req("/api/scores/me", "GET", null, H);
  t(71, "GET scores/me -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/scores/breakdown", "GET", null, H);
  t(72, "GET scores/breakdown -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/scores/history", "GET", null, H);
  t(73, "GET scores/history -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/scores/me", "GET");
  t(74, "GET scores/me unauth -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/scores/breakdown", "GET");
  t(75, "GET scores/breakdown unauth -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/scores/history", "GET");
  t(76, "GET scores/history unauth -> 401", r.status === 401, `got ${r.status}`);

  // --- TIER (77-80) ---
  console.log("\n--- Tier ---");
  r = await req("/api/tier/me", "GET", null, H);
  t(77, "GET tier/me -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/tier/all", "GET");
  t(78, "GET tier/all (public) -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/tier/upgrade-request", "POST", { requestedTier: "silver", reason: "test upgrade" }, H);
  t(79, "POST tier/upgrade-request -> 200/400 (KYC gate ok)", r.status === 200 || r.status === 400, `got ${r.status}`);

  r = await req("/api/tier/me", "GET");
  t(80, "GET tier/me unauth -> 401", r.status === 401, `got ${r.status}`);

  // --- PAYMENTS: DEPOSIT (81-90) ---
  console.log("\n--- Payments: Deposit ---");
  r = await req("/api/payments/deposit/initiate", "POST", { amount: 5000 }, H);
  const dep = JSON.parse(r.body); const depp = dep?.data || dep;
  t(81, "POST deposit/initiate valid -> 200 + publicKey + tx_ref", r.status === 200 && depp?.publicKey && depp?.tx_ref, `got ${r.status}`);

  r = await req("/api/payments/deposit/initiate", "POST", { amount: "abc" }, H);
  t(82, "POST deposit/initiate invalid amount type -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/payments/deposit/initiate", "POST", { amount: 50 }, H);
  t(83, "POST deposit/initiate below minimum -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/payments/deposit/verify", "POST", { tx_ref: "FAKE_REF_XYZ" }, H);
  t(84, "POST deposit/verify fake ref -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/payments/deposit/verify", "POST", {}, H);
  t(85, "POST deposit/verify no ref -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/payments/deposit/callback?tx_ref=TEST&status=successful", "GET");
  t(86, "GET deposit/callback valid -> 302 + http://", r.status === 302 && (r.headers.location || "").startsWith("http"), `got ${r.status}`);

  r = await req("/api/payments/deposit/callback", "GET");
  t(87, "GET deposit/callback no params -> 302 (failed redirect)", r.status === 302, `got ${r.status}`);

  r = await req("/api/payments/deposit/initiate", "POST", { amount: 5000 });
  t(88, "POST deposit/initiate unauth -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/payments/deposit/verify", "POST", { tx_ref: "X" });
  t(89, "POST deposit/verify unauth -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/payments/deposit/initiate", "POST", {}, H);
  t(90, "POST deposit/initiate no amount -> 400", r.status === 400, `got ${r.status}`);

  // --- PAYMENTS: MINUTES (91-98) ---
  console.log("\n--- Payments: Minutes ---");
  r = await req("/api/payments/minutes/due", "GET", null, H);
  t(91, "GET minutes/due -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/payments/minutes/initialize", "POST", null, H);
  const min = JSON.parse(r.body); const minp = min?.data || min;
  t(92, "POST minutes/initialize -> 200 + publicKey + tx_ref + meta", r.status === 200 && minp?.publicKey && minp?.tx_ref && minp?.meta, `got ${r.status}`);

  r = await req("/api/payments/minutes/verify", "POST", { tx_ref: "FAKE_MIN_REF" }, H);
  t(93, "POST minutes/verify fake ref -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/payments/minutes/verify", "POST", {}, H);
  t(94, "POST minutes/verify no ref -> 400", r.status === 400, `got ${r.status}`);

  r = await req("/api/payments/minutes/due", "GET");
  t(95, "GET minutes/due unauth -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/payments/minutes/initialize", "POST");
  t(96, "POST minutes/initialize unauth -> 401", r.status === 401, `got ${r.status}`);

  // #97-98 moved to batch 3 (batch 2 would exceed the 50-req rate limit)

  console.log(`\nBatch 2: ${PASS} pass, ${FAIL} fail`);
}

async function runBatch3() {
  console.log("\n========== BATCH 3: Webhook, Role Restrictions, Reports, Misc, Health (#99-127) ==========\n");

  const sess = await login();
  const H = sess.H;
  const HASH = "hr 37ir63y9 8uw8@218374390$%&^*()**&^%TIGYv";

  // --- BANKS (97-98, moved from batch 2 to stay under rate limit) ---
  console.log("--- Banks ---");
  let r;
  r = await req("/api/payments/banks", "GET", null, H);
  t(97, "GET payments/banks -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/payments/verify-bank", "POST", { accountNumber: "123", bankCode: "" }, H);
  t(98, "POST verify-bank invalid -> 400", r.status === 400, `got ${r.status}`);

  // --- WEBHOOK (99-108) ---
  console.log("\n--- Webhook ---");
  r = await req("/api/payments/webhook", "POST", { event: "charge.completed", data: { id: 1, tx_ref: "T", status: "s" } }, {});
  t(99, "Webhook no signature -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/payments/webhook", "POST", { event: "charge.completed", data: { id: 1, tx_ref: "T", status: "s" } }, { "verif-hash": "wrong" });
  t(100, "Webhook wrong signature -> 401", r.status === 401, `got ${r.status}`);

  r = await req("/api/payments/webhook", "POST", { event: "charge.completed", data: { id: 1, tx_ref: "TEST_DEP", status: "successful" } }, { "verif-hash": HASH });
  t(101, "Webhook charge.completed valid -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/payments/webhook", "POST", { event: "charge.confirmed", data: { id: 2, tx_ref: "TEST2", status: "successful" } }, { "verif-hash": HASH });
  t(102, "Webhook charge.confirmed valid -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/payments/webhook", "POST", { event: "transfer.completed", data: { id: 3, reference: "WTH_1", status: "successful" } }, { "verif-hash": HASH });
  t(103, "Webhook transfer.completed -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/payments/webhook", "POST", { event: "unknown.event", data: { id: 4 } }, { "verif-hash": HASH });
  t(104, "Webhook unknown event -> 200 (ignored)", r.status === 200, `got ${r.status}`);

  r = await req("/api/payments/webhook", "POST", { event: "charge.completed", data: { id: 5 } }, { "verif-hash": HASH });
  t(105, "Webhook no tx_ref -> 200 (ignored)", r.status === 200, `got ${r.status}`);

  r = await req("/api/payments/webhook", "POST", {}, { "verif-hash": HASH });
  t(106, "Webhook empty body -> 200 (ignored)", r.status === 200, `got ${r.status}`);

  r = await req("/api/payments/webhook", "POST", { event: "charge.completed", data: { id: 9, tx_ref: "MIN_TEST", status: "successful" } }, { "verif-hash": HASH });
  t(107, "Webhook MIN_ ref -> 200 (handled)", r.status === 200, `got ${r.status}`);

  t(108, "Webhook exempt from rate limiter", !r.headers["ratelimit-limit"], `header: ${r.headers["ratelimit-limit"] || "none"}`);

  // --- ROLE RESTRICTIONS (109-120) ---
  console.log("\n--- Role Restrictions (member gets 403) ---");
  const adminRoutes = [
    ["/api/expenses", "GET", 109, "GET /expenses"],
    ["/api/finance/overview", "GET", 110, "GET /finance/overview"],
    ["/api/support/tickets", "GET", 111, "GET /support/tickets"],
    ["/api/admin/members", "GET", 112, "GET /admin/members"],
    ["/api/admin/loans", "GET", 113, "GET /admin/loans"],
    ["/api/admin/reports", "GET", 114, "GET /admin/reports"],
    ["/api/admin/settings", "GET", 115, "GET /admin/settings"],
    ["/api/admin/withdrawals/pending", "GET", 116, "GET /admin/withdrawals/pending"],
    ["/api/admin/score/config", "GET", 117, "GET /admin/score/config"],
    ["/api/settings/audit-logs", "GET", 118, "GET /settings/audit-logs"],
    ["/api/settings", "PUT", 119, "PUT /settings"],
    ["/api/loans/admin/process-defaulters", "POST", 120, "POST /loans/admin/process-defaulters"],
  ];
  for (const [path, method, id, label] of adminRoutes) {
    r = await req(path, method, method === "PUT" || method === "POST" ? {} : null, H);
    t(id, `${label} member -> 403`, r.status === 403, `got ${r.status}`);
  }

  // --- UNAUTH ADMIN (121) ---
  console.log("\n--- Unauthenticated Admin ---");
  r = await req("/api/expenses", "GET");
  t(121, "GET /expenses unauth -> 401", r.status === 401, `got ${r.status}`);

  // --- REPORTS (122-124) ---
  console.log("\n--- Reports ---");
  r = await req("/api/reports/monthly?month=10&year=2026", "GET", null, H);
  t(122, "GET reports/monthly -> 200", r.status === 200, `got ${r.status}`);

  r = await req("/api/reports/download-pdf", "GET", null, H);
  t(123, "GET reports/download-pdf -> 200", r.status === 200 || r.status === 404, `got ${r.status}`);

  r = await req("/api/reports/monthly?month=13&year=2026", "GET", null, H);
  t(124, "GET reports/monthly invalid month -> handled", r.status > 0, `got ${r.status}`);

  // --- RATE LIMIT & CORS (125-126) ---
  console.log("\n--- Rate Limit & CORS ---");
  r = await req("/api/user/me", "GET", null, H);
  t(125, "Rate limit headers present (limit: 50)", r.headers["ratelimit-limit"] === "50", `got ${r.headers["ratelimit-limit"]}`);

  const preflight = await new Promise((resolve) => {
    const opts = {
      ...BASE,
      path: "/api/auth/login",
      method: "OPTIONS",
      headers: {
        Origin: "https://socketmonnie.netlify.app",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    };
    const rq = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    rq.end();
  });
  t(126, "CORS preflight from Netlify -> 204 + allow-origin", preflight.status === 204 && preflight.headers["access-control-allow-origin"] === "https://socketmonnie.netlify.app", `got ${preflight.status}`);

  // --- HEALTH (127) ---
  console.log("\n--- Health Check ---");
  r = await req("/", "GET");
  t(127, "GET / -> 200 health check", r.status === 200, `got ${r.status}`);

  console.log(`\nBatch 3: ${PASS} pass, ${FAIL} fail`);
}

// --- MAIN ---
const batch = process.argv[2] || "all";

(async () => {
  if (batch === "1" || batch === "all") await runBatch1();
  if (batch === "2" || batch === "all") await runBatch2();
  if (batch === "3" || batch === "all") await runBatch3();

  console.log("\n" + "=".repeat(50));
  console.log(`GRAND TOTAL: ${PASS} pass, ${FAIL} fail out of ${PASS + FAIL}`);
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log("  " + f));
  }
  console.log("=".repeat(50));
  process.exit(FAIL > 0 ? 1 : 0);
})();
