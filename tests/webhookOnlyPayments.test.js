/**
 * Webhook-only payment regression suite.
 *
 * These tests lock in the corrected architecture:
 *  - the signed Flutterwave webhook is the only settlement path;
 *  - each payment category resolves through its own dedicated model;
 *  - browser redirect data can never confirm, settle or reconcile a payment;
 *  - receipt claims survive later transaction upserts;
 *  - guarantor liability is capped at 25% of original principal and failed
 *    collections reduce the guarantor's SocketScore.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const region = (source, from, to) => {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `missing start marker: ${from}`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `missing end marker: ${to}`);
  return source.slice(start, end);
};

const paymentService = read("Services/PaymentService.js");
const paymentRepository = read("Repositories/PaymentRepository.js");
const savingsRepository = read("Repositories/SavingsRepository.js");
const loanRepository = read("Repositories/LoanRepository.js");
const transactionService = read("Services/TransactionService.js");
const loanService = read("Services/LoanService.js");
const defaulterEngine = read("Utilis/loanDefaulterEngine.js");

/* ---------------- exact provider payload from the incident ---------------- */

test("the reported MEM_ webhook payload normalizes without redirect status", () => {
  const { PaymentService } = require("../Services/PaymentService");
  const payload = {
    amount: 1000,
    charged_amount: 1000,
    currency: "NGN",
    status: "completed",
    tx_ref: "MEM_1794908514777_e8d78180_33ec94",
    flw_ref: "MockFLWRef-1794908552934",
    transaction_id: 10618804,
    charge_response_code: "00",
    charge_response_message: "Approved Successful",
    redirectstatus: undefined,
  };

  const normalized = PaymentService.normalizeWebhookData({
    ...payload,
    reference: payload.tx_ref,
  });

  assert.equal(normalized.tx_ref, "MEM_1794908514777_e8d78180_33ec94");
  assert.equal(normalized.status, "completed");
  assert.equal(normalized.charged_amount, 1000);
  assert.equal(normalized.amount_settled, 1000);
  assert.equal(normalized.currency, "NGN");
  assert.equal(normalized.flw_ref, "MockFLWRef-1794908552934");
  assert.equal(normalized.charge_response_code, "00");
  assert.ok(!("redirectstatus" in normalized) || normalized.redirectstatus === undefined);
});

/* ---------------- webhook dispatch and model separation ---------------- */

test("all four payment categories dispatch by server-owned prefix", () => {
  assert.ok(paymentService.includes('reference.startsWith("DEP_")'));
  assert.ok(paymentService.includes('reference.startsWith("LRP_")'));
  assert.ok(paymentService.includes('reference.startsWith("RPL_")'));
  assert.ok(paymentService.includes('reference.startsWith("MEM_")'));
  assert.ok(paymentService.includes('reference.startsWith("MIN_")'));
});

test("each checkout resolves through its own dedicated transaction model", () => {
  assert.ok(paymentRepository.includes('LoanTransaction.findOne({ reference, type: "loan_repayment" })'));
  assert.ok(paymentRepository.includes('MinuteTransaction.findOne({ reference, type: "minute_contribution" })'));
  assert.ok(paymentRepository.includes('MembershipTransaction.findOne({ reference, type: "membership_fee" })'));
  assert.ok(!paymentRepository.includes('Savings.findOne({ reference, type: "loan_repayment" })'));
});

test("savings balance, history and loan evidence exclude legacy minutes rows", () => {
  assert.ok(savingsRepository.includes('category: { $ne: "minutes_payment" }'));
  assert.ok(loanRepository.includes('category: { $ne: "minutes_payment" }'));
  assert.ok(loanRepository.includes('const Savings = require("../Models/SavingsModel")'));
  assert.ok(paymentRepository.includes('category: { $ne: "minutes_payment" }'));
});

/* ---------------- no callback settlement ---------------- */

test("callback and verify settlement routes are removed", () => {
  const routeSources = [
    read("Routes/PaymentRoutes.js"),
    read("Routes/SavingsRoute.js"),
    read("Routes/LoanRoutes.js"),
  ].join("\n");

  assert.ok(!routeSources.includes('"/deposit/callback"'));
  assert.ok(!routeSources.includes('"/deposit/verify"'));
  assert.ok(!routeSources.includes('"/minutes/verify"'));
  assert.ok(!routeSources.includes('"/membership-fee/verify"'));
  assert.ok(!routeSources.includes('"/repay/verify"'));
  assert.ok(routeSources.includes('router.post("/webhook"'));
  assert.ok(routeSources.includes('router.get("/status/:reference"'));
});

test("frontend callback navigation never invokes a verify endpoint", () => {
  const nav = read("../Frontend/src/utils/paymentResultNav.js");
  const pages = [
    "../Frontend/src/pages/user/SavingsDeposit.jsx",
    "../Frontend/src/pages/user/MembershipFee.jsx",
    "../Frontend/src/pages/user/Minutes.jsx",
    "../Frontend/src/pages/user/LoanRepay.jsx",
  ].map((p) => read(p)).join("\n");

  assert.ok(!nav.includes("verify"));
  assert.ok(!pages.includes("verifyDeposit("));
  assert.ok(!pages.includes("verifyMembershipFee("));
  assert.ok(!pages.includes("verifyMinutesContribution("));
  assert.ok(!pages.includes("verifyLoanRepayment("));
  assert.ok(!pages.includes("verify:"));
});

test("status endpoint is a read model: no provider calls, reconciliation or writes", () => {
  const statusFn = region(
    paymentService,
    "const getPaymentStatus = async",
    "const PaymentService = {"
  );
  assert.ok(statusFn.includes("Webhook-only confirmation"));
  assert.ok(!statusFn.includes("verifyTransactionById"));
  assert.ok(!statusFn.includes("reconcilePaymentByReference"));
  assert.ok(!statusFn.includes(".save("));
  assert.ok(!statusFn.includes("findOneAndUpdate"));
});

test("reconciliation cron is not started at boot", () => {
  const app = read("Server/app.js");
  assert.ok(!app.includes("startReconciliationCron()"));
  assert.match(app, /webhook-only confirmation/i);
});

/* ---------------- minutes settlement correctness ---------------- */

test("minutes webhook requires the server-created intent and has no fallback chain", () => {
  const minutesFn = region(
    paymentService,
    "const handleMinuteWebhook = async",
    "const normalizeWebhookData ="
  );

  assert.ok(minutesFn.includes("findMinutesCheckoutByReference(reference)"));
  assert.ok(minutesFn.includes("if (!pendingPayment)"));
  assert.ok(minutesFn.includes("Number(pendingPayment.amount"));
  assert.ok(minutesFn.includes('{ _id: pendingPayment._id, status: "pending" }'));
  assert.ok(!minutesFn.includes("meta.userId"));
  assert.ok(!minutesFn.includes("customer.email"));
  assert.ok(!minutesFn.includes("fallback-chain"));
});

test("zero settled months cannot leave a completed minutes checkout", () => {
  const minutesFn = region(
    paymentService,
    "const handleMinuteWebhook = async",
    "const normalizeWebhookData ="
  );

  assert.ok(minutesFn.includes('await failClaim("no_outstanding_minutes")'));
  assert.ok(minutesFn.includes('await failClaim("underpayment")'));
  assert.ok(minutesFn.includes('await failClaim("budget_did_not_fit_any_obligation")'));
  assert.ok(minutesFn.includes('await failClaim("obligations_already_settled")'));
  assert.ok(minutesFn.includes('status: "failed"'));
  assert.ok(minutesFn.includes("{ session }"));
});

/* ---------------- receipt exactly-once metadata durability ---------------- */

test("transaction upserts preserve receipt-service-owned metadata", async () => {
  const { upsertByReference } = require("../Services/TransactionService");
  let capturedUpdate = null;
  let stored = {
    reference: "DEP_test",
    metadata: {
      receiptEmailState: "sent",
      receiptEmailMessageId: "brevo-1",
      source: "depositWebhook",
    },
  };

  const Model = {
    findOneAndUpdate(filter, update) {
      capturedUpdate = update;
      for (const [key, value] of Object.entries(update.$set || {})) {
        if (key === "metadata") {
          stored.metadata = value;
          continue;
        }
        const parts = key.split(".");
        let cursor = stored;
        for (let i = 0; i < parts.length - 1; i += 1) {
          cursor[parts[i]] = cursor[parts[i]] || {};
          cursor = cursor[parts[i]];
        }
        cursor[parts[parts.length - 1]] = value;
      }
      return Promise.resolve(stored);
    },
  };

  await upsertByReference(Model, "DEP_test", {
    userId: "user-1",
    amount: 5000,
    status: "completed",
    metadata: {
      source: "depositWebhook",
      providerTransactionId: "FLW-1",
      receiptEmailState: "claiming",
    },
  });

  assert.equal(capturedUpdate.$set.metadata, undefined);
  assert.equal(capturedUpdate.$set["metadata.providerTransactionId"], "FLW-1");
  assert.equal(capturedUpdate.$set["metadata.receiptEmailState"], undefined);
  assert.equal(stored.metadata.receiptEmailState, "sent");
  assert.equal(stored.metadata.receiptEmailMessageId, "brevo-1");
  assert.equal(stored.metadata.providerTransactionId, "FLW-1");
});

/* ---------------- guarantor rules ---------------- */

test("guarantor liability is capped at 25% of original principal", () => {
  assert.ok(loanService.includes("guarantorLiability = Math.round(totalRepayable * 0.25"));
  assert.ok(loanService.includes("guaranteedAmount: guarantorLiability"));
  assert.ok(defaulterEngine.includes("loan.principalAmount || loan.totalRepayable"));
  assert.ok(defaulterEngine.includes("Math.min(principalCap, recordedCap || principalCap)"));
  assert.ok(!defaulterEngine.includes("totalRecoveryObligation - allocated"));
});

test("failed guarantor collection reduces the guarantor SocketScore by 10", () => {
  assert.ok(defaulterEngine.includes("GUARANTOR_FAILURE_SCORE_DELTA = -10"));
  assert.ok(defaulterEngine.includes("applyFailedGuarantorCollectionScore"));
  assert.ok(defaulterEngine.includes("failed_guarantor_collection"));
  assert.ok(defaulterEngine.includes('attemptFailed ? "failed" : "pending"'));
});

test("webhook replays retry receipt delivery without duplicating it", () => {
  assert.ok(
    paymentService.includes("const retrySettledReceipt = (args) => sendPaymentReceiptSafe(args)")
  );
  for (const model of [
    "SavingsTransaction",
    "LoanTransaction",
    "MembershipTransaction",
    "MinuteTransaction",
  ]) {
    assert.ok(paymentService.includes(`Model: ${model},`), model);
  }
  assert.ok(paymentService.includes("already processed - checking receipt claim"));
  assert.ok(paymentService.includes("membershipWebhookRetry"));
});

test("receipt service still uses the atomic claim states", () => {
  const receipt = read("Services/ReceiptService.js");
  assert.ok(receipt.includes('"metadata.receiptEmailState": { $nin: ["claiming", "sent"] }'));
  assert.ok(receipt.includes('"metadata.receiptEmailState": "claiming"'));
  assert.ok(receipt.includes('markReceiptState(Model, reference, "sent"'));
  assert.ok(receipt.includes('markReceiptState(Model, reference, "failed"'));
});

test("overpayment state remains review-only, never an automatic refund", () => {
  assert.ok(loanService.includes("refund_review"));
  assert.ok(!loanService.includes("issueRefund("));
});

test("membership checkout is owned by its own service, controller and route", () => {
  const { SavingsService } = require("../Services/SavingsService");
  assert.equal("initializeMembershipFee" in SavingsService, false);
  assert.equal("verifyMembershipFee" in SavingsService, false);

  const savingsController = require("../Controllers/SavingsController");
  assert.equal("initializeMembershipFee" in savingsController, false);
  assert.equal("verifyMembershipFee" in savingsController, false);

  const { initializeMembershipFee } = require("../Controllers/MembershipController");
  assert.equal(typeof initializeMembershipFee, "function");

  const membershipRoutes = read("Routes/MembershipRoutes.js");
  assert.ok(membershipRoutes.includes('MembershipRoutes.post("/initialize"'));
  assert.ok(!read("Routes/SavingsRoute.js").includes("membership-fee"));
  assert.ok(read("Server/app.js").includes('app.use("/api/membership", MembershipRoutes)'));
});

test("no callback or browser verify settlement handlers remain", () => {
  const paymentController = read("Controllers/PaymentController.js");
  assert.ok(!paymentController.includes("paymentCallback"));
  assert.ok(!paymentController.includes("exports.verifyDeposit"));

  assert.ok(!paymentService.includes("const verifyDeposit"));
  assert.ok(!paymentService.includes("const reconcileDepositByReference"));
  assert.ok(!paymentService.includes("const reconcilePaymentByReference"));

  const loanController = read("Controllers/LoanController.js");
  const loanServiceSource = read("Services/LoanService.js");
  assert.ok(!loanController.includes("exports.verifyLoanRepayment"));
  assert.ok(!loanServiceSource.includes("const verifyLoanRepayment"));

  assert.ok(!read("Middleware/PaymentValidate.js").includes("validateVerifyDeposit"));
  assert.ok(!read("Middleware/LoanValidate.js").includes("validateRepayVerify"));

  const serviceExports = require("../Services/PaymentService").PaymentService;
  assert.equal("verifyDeposit" in serviceExports, false);
  assert.equal("reconcileDepositByReference" in serviceExports, false);
  assert.equal("reconcilePaymentByReference" in serviceExports, false);
});
