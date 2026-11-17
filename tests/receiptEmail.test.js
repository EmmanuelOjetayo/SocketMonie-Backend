/**
 * Receipt email regression tests.
 *
 * Guarantees:
 *  - Exactly-once delivery: an atomic claim on the transaction record means a
 *    payment can never produce duplicate receipts (webhook + callback race).
 *  - Email failure NEVER fails the payment pipeline — the record's receipt
 *    state flips to "failed" and the caller receives `{ sent: false }`.
 *  - Missing member email is handled gracefully (marked failed, no crash).
 *  - Receipt HTML escapes user-controlled content.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const receiptTemplate = require("../Utilis/emailTemplates/receipt");
const { createReceiptService, buildSubject, TYPE_LABELS } = require("../Services/ReceiptService");

/* ---------------- template sanity ---------------- */

test("receiptTemplate escapes user-controlled HTML", () => {
  const html = receiptTemplate(
    '<img src=x onerror=alert(1)>',
    "5,000",
    "REF<script>alert(1)</script>",
    "Savings Deposit"
  );
  assert.equal(html.includes("<img src=x"), false);
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.ok(html.includes("&lt;img src=x"));
  assert.ok(html.includes("REF&lt;script&gt;"));
});

test("receiptTemplate includes amount, reference and transaction type", () => {
  const html = receiptTemplate("Ada", "50,000", "DEP_123_abc", "Savings Deposit");
  assert.ok(html.includes("50,000"));
  assert.ok(html.includes("DEP_123_abc"));
  assert.ok(html.includes("Savings Deposit"));
});

test("buildSubject is spam-safe (no exclamation marks, includes label)", () => {
  const subject = buildSubject("deposit");
  assert.equal(subject.includes("!"), false);
  assert.ok(subject.includes(TYPE_LABELS.deposit));
});

/* ---------------- mock transaction record ---------------- */

const createMockModel = () => {
  const doc = { reference: "TEST_REF", metadata: {} };

  // Mongoose-like chained API: Model.findOneAndUpdate(filter, update, opts).lean()
  const findOneAndUpdate = (filter, update) => {
    const state = doc.metadata.receiptEmailState;
    const nin = (filter?.["metadata.receiptEmailState"] || {}).$nin || [];
    const dottedLookup = filter?.["metadata.receiptEmailState"] || {};
    const matchesReference = filter.reference === doc.reference;
    const matchesState = !state || !nin.includes(state);

    if (!matchesReference || !matchesState) {
      return { lean: async () => null };
    }

    const set = update?.$set || {};
    const apply = (path, value) => {
      const segments = path.split(".");
      let target = doc;
      for (let i = 0; i < segments.length - 1; i++) {
        target[segments[i]] = target[segments[i]] || {};
        target = target[segments[i]];
      }
      target[segments[segments.length - 1]] = value;
    };
    for (const [path, value] of Object.entries(set)) apply(path, value);

    return { lean: async () => JSON.parse(JSON.stringify(doc)) };
  };

  return { findOneAndUpdate, _doc: doc };
};

const baseArgs = (Model, extra = {}) => ({
  userId: "user-1",
  Model,
  type: "deposit",
  reference: "TEST_REF",
  transactionId: "TX-1",
  amount: 5000,
  currency: "NGN",
  paidAt: new Date("2026-11-17T10:00:00.000Z").toISOString(),
  ...extra,
});

test("successful delivery marks the record sent exactly once", async () => {
  const Model = createMockModel();
  const sent = [];
  const service = createReceiptService({
    sendEmail: async (payload) => {
      sent.push(payload);
      return { success: true, messageId: "brevo-1" };
    },
    findUser: async () => ({ fullName: "Ada", email: "ada@example.com" }),
  });

  const first = await service.sendPaymentReceipt(baseArgs(Model));
  assert.equal(first.sent, true);
  assert.equal(Model._doc.metadata.receiptEmailState, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "ada@example.com");
  assert.ok(sent[0].subject.includes("Savings Deposit"));
  assert.ok(sent[0].html.includes("5,000"));

  // Replay — never sends a second email.
  const replay = await service.sendPaymentReceipt(baseArgs(Model));
  assert.equal(replay.sent, false);
  assert.equal(replay.reason, "already_claimed");
  assert.equal(sent.length, 1);
});

test("provider failure does not throw and marks the record failed (retryable)", async () => {
  const Model = createMockModel();
  const service = createReceiptService({
    sendEmail: async () => ({ success: false, error: "brevo down" }),
    findUser: async () => ({ fullName: "Ada", email: "ada@example.com" }),
  });

  const first = await service.sendPaymentReceipt(baseArgs(Model));
  assert.equal(first.sent, false);
  assert.equal(first.reason, "provider_failed");
  assert.equal(Model._doc.metadata.receiptEmailState, "failed");

  // A "failed" claim is re-claimable — a later retry is possible.
  const second = await service.sendPaymentReceipt(baseArgs(Model));
  assert.equal(second.sent, false);
  assert.equal(second.reason, "provider_failed");
});

test("an already-claiming record is not double-sent", async () => {
  const Model = createMockModel();
  Model._doc.metadata.receiptEmailState = "claiming";
  const service = createReceiptService({
    sendEmail: async () => ({ success: true, messageId: "msg" }),
    findUser: async () => ({ fullName: "Ada", email: "ada@example.com" }),
  });

  const res = await service.sendPaymentReceipt(baseArgs(Model));
  assert.equal(res.sent, false);
  assert.equal(res.reason, "already_claimed");
});

test("member without an email on file is marked failed, no send attempted", async () => {
  const Model = createMockModel();
  let attempted = 0;
  const service = createReceiptService({
    sendEmail: async () => {
      attempted += 1;
      return { success: true, messageId: "msg" };
    },
    findUser: async () => ({ fullName: "Ghost" }), // no email
  });

  const res = await service.sendPaymentReceipt(baseArgs(Model));
  assert.equal(res.sent, false);
  assert.equal(res.reason, "missing_email");
  assert.equal(attempted, 0);
  assert.equal(Model._doc.metadata.receiptEmailState, "failed");
});

test("provider throwing an exception still isolates the payment", async () => {
  const Model = createMockModel();
  const service = createReceiptService({
    sendEmail: async () => {
      throw new Error("network explosion");
    },
    findUser: async () => ({ fullName: "Ada", email: "ada@example.com" }),
  });

  const res = await service.sendPaymentReceipt(baseArgs(Model));
  assert.equal(res.sent, false);
  assert.equal(res.reason, "error");
  assert.equal(Model._doc.metadata.receiptEmailState, "failed");
});
