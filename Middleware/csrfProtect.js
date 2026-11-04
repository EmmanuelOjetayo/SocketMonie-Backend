const crypto = require("crypto");

/**
 * CSRF protection for state-changing API requests (owner-approved decision #3).
 *
 * The SPA is authenticated with an httpOnly JWT cookie sent with
 * SameSite=None in production (required for the cross-origin Netlify →
 * Render flow). A cross-site attacker can force that cookie to ride along
 * on a forged POST/PATCH/PUT/DELETE — CORS alone cannot stop this, because
 * browsers send such "simple" requests without a preflight.
 *
 * Defence in depth (do NOT rely on CORS alone):
 *   1. Origin/Referer (when present) must match the trusted allowlist.
 *   2. Double-submit token: a JS-readable `csrfToken` cookie must match the
 *      `X-CSRF-Token` custom request header. Cross-site attackers can make
 *      the cookie ride along, but can never read it (SameSite-origin rules)
 *      nor set a custom header on a simple cross-site request.
 *
 * Comparison is timing-safe; secrets are never logged.
 */

const isProduction = process.env.NODE_ENV === "production";

const CSRF_COOKIE = "csrfToken";
const CSRF_HEADER = "x-csrf-token";

// Keep in sync with Server/app.js allowlist.
const trustedOrigins = [
  "http://localhost:5173",
  "https://socketmonnie.netlify.app",
  "https://socketmonnie.onrender.com",
].concat(
  [process.env.FRONTEND_URL, process.env.CLIENT_URL]
    .filter(Boolean)
    .map((u) => String(u).replace(/\/$/, ""))
);

// Server-to-server / session-establishing endpoints that cannot present a
// browser-issued token:
// - Flutterwave webhook & payment callbacks: protected by verif-hash signature.
// - /api/auth/*: establish the session (no CSRF cookie exists yet).
const CSRF_EXEMPT_PATHS = [
  /^\/api\/payments\/(webhook|callback)/i,
  /^\/api\/auth\//i,
];

const newToken = () => crypto.randomBytes(32).toString("hex");

// timingSafeEqual throws on length mismatch — compare constant-length SHA-256
// digests so length never leaks.
const tokensMatch = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const da = crypto.createHash("sha256").update(a).digest();
  const db = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(da, db);
};

const isTrustedOrigin = (origin) => {
  const normalized = String(origin || "").replace(/\/$/, "");
  return trustedOrigins.includes(normalized);
};

/**
 * Issue a fresh CSRF token (double-submit bootstrap).
 * Non-httpOnly so the SPA can mirror it into the X-CSRF-Token header.
 */
const issueCsrfCookie = (res) => {
  res.cookie(CSRF_COOKIE, newToken(), {
    httpOnly: false,
    sameSite: isProduction ? "none" : "lax",
    secure: isProduction,
    maxAge: 24 * 60 * 60 * 1000, // 24h, refreshed on login/verify/misfires
  });
};

function csrfProtect(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }

  if (CSRF_EXEMPT_PATHS.some((rx) => rx.test(req.path))) {
    return next();
  }

  // 1. Explicit origin check (never rely on CORS alone).
  const origin = req.headers.origin || req.headers.referer || "";
  if (origin && !isTrustedOrigin(origin)) {
    return res.status(403).json({
      success: false,
      code: "CSRF_ORIGIN_REJECTED",
      message: "Request origin is not trusted.",
    });
  }

  // 2. Double-submit token comparison.
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];

  if (!cookieToken || !headerToken || !tokensMatch(cookieToken, headerToken)) {
    // Bootstrap: no cookie at all yet (first visit after deploy / re-login).
    // Issue one so the SPA can retry; an attacker cannot use the response,
    // and a mismatched pair is rejected outright.
    if (!cookieToken) issueCsrfCookie(res);
    return res.status(403).json({
      success: false,
      code: "CSRF_TOKEN_INVALID",
      message: "Security token expired or missing. Please retry the action.",
    });
  }

  return next();
}

module.exports = { csrfProtect, issueCsrfCookie, __internals: { tokensMatch, isTrustedOrigin, CSRF_COOKIE, CSRF_HEADER } };
