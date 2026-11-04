/**
 * Owner-approved Batch E regression tests (no DB / no network):
 *  1. CSRF double-submit internals (timing-safe compare, origin allowlist).
 *  2. Draft sanitizer (never persists passwords/OTPs/PINs/tokens/secrets).
 *  3. Draft 30-day inactivity expiry rule.
 * Run: node Backend/tests/batchE.test.js
 */
const assert = require("assert");

const { __internals } = require("../Middleware/csrfProtect");
const draftUtils = require("../Utilis/draftSanitizer");

const results = { passed: 0, failed: 0 };

const run = async (tests) => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      results.passed++;
      console.log(`  \u2705 ${name}`);
    } catch (err) {
      results.failed++;
      console.error(`  \u274C ${name}\n     ${err.message}`);
    }
  }
  console.log(`\nBatch E tests: ${results.passed} passed, ${results.failed} failed, ${tests.length} total`);
  if (results.failed > 0) process.exit(1);
};

const tests = [];

tests.push({
  name: "CSRF: matching tokens compare true (constant-length digest)",
  fn: async () => {
    const t1 = "a".repeat(64);
    assert.strictEqual(__internals.tokensMatch(t1, t1), true);
  },
});

tests.push({
  name: "CSRF: mismatched tokens compare false (timing-safe)",
  fn: async () => {
    assert.strictEqual(__internals.tokensMatch("a".repeat(64), "b".repeat(64)), false);
  },
});

tests.push({
  name: "CSRF: non-string inputs compare false without throwing",
  fn: async () => {
    assert.strictEqual(__internals.tokensMatch(undefined, "x"), false);
    assert.strictEqual(__internals.tokensMatch("x", null), false);
  },
});

tests.push({
  name: "CSRF: trusted origin allowlist accepts production SPA origin",
  fn: async () => {
    assert.strictEqual(__internals.isTrustedOrigin("https://socketmonnie.netlify.app"), true);
    assert.strictEqual(__internals.isTrustedOrigin("https://socketmonnie.netlify.app/"), true);
    assert.strictEqual(__internals.isTrustedOrigin("http://localhost:5173"), true);
  },
});

tests.push({
  name: "CSRF: attacker origin is rejected",
  fn: async () => {
    assert.strictEqual(__internals.isTrustedOrigin("https://evil.example.com"), false);
    assert.strictEqual(__internals.isTrustedOrigin(""), false);
  },
});

tests.push({
  name: "Draft sanitizer: strips passwords, OTPs, PINs, tokens, secrets",
  fn: async () => {
    const dirty = {
      values: { amount: "50000", password: "hunter2", otp: "123456", restorePin: "1111" },
      loanToken: "abc",
      apiSecret: "xyz",
      authHeader: "Bearer abc",
      step: 2,
    };
    assert.deepStrictEqual(draftUtils.sanitizeDraftData(dirty), { values: { amount: "50000" }, step: 2 });
  },
});

tests.push({
  name: "Draft sanitizer: keeps ordinary UI state intact",
  fn: async () => {
    const draft = {
      step: 4,
      values: { amount: "100000", purpose: "school fees" },
      guarantorStatuses: ["accepted", "accepted", "accepted", "accepted"],
    };
    assert.deepStrictEqual(draftUtils.sanitizeDraftData(draft), draft);
  },
});

tests.push({
  name: "Draft sanitizer: prunes undefined branches from nested objects",
  fn: async () => {
    assert.deepStrictEqual(draftUtils.sanitizeDraftData({ a: { password: "x", keep: 1 } }), { a: { keep: 1 } });
  },
});

tests.push({
  name: "Draft expiry: 30-day inactivity boundary math",
  fn: async () => {
    const { DRAFT_INACTIVITY_DAYS, expiresAtFor } = draftUtils;
    const day = 24 * 60 * 60 * 1000;

    const recent = new Date(Date.now() - 29 * day);
    assert.strictEqual(expiresAtFor(recent) > Date.now(), true, "29 days old must NOT be expired");

    const stale = new Date(Date.now() - 31 * day);
    assert.strictEqual(expiresAtFor(stale) < Date.now(), true, "31 days old must be expired");
    assert.strictEqual(DRAFT_INACTIVITY_DAYS, 30);
  },
});

run(tests);
