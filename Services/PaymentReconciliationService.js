/**
 * Payment Reconciliation Service — FALLBACK 2.
 *
 * Server-side background sweeper for payments the Flutterwave webhook
 * never confirmed (downtime, rejected/malformed webhook, closed browser
 * before callback, async bank-transfer settlement, etc.).
 *
 * It reuses PaymentService.reconcilePaymentByReference(), which verifies
 * each tx_ref against Flutterwave and completes it through the SAME
 * idempotent handlers the webhook uses — so delayed events converge to the
 * identical outcome without double credit.
 */

const mongoose = require("mongoose");
const Savings = require("../Models/SavingsModel");
const Minutes = require("../Models/MinutesModel");
const User = require("../Models/UserModel");
const { PaymentService } = require("./PaymentService");

const STALE_MINUTES = Number(process.env.RECONCILE_STALE_MINUTES || 10);
const BATCH_LIMIT = Number(process.env.RECONCILE_BATCH_LIMIT || 50);
// Cooldown for references Flutterwave cannot resolve (avoids API hammering).
const NOT_FOUND_COOLDOWN_MS = 30 * 60 * 1000;
const lastAttempt = new Map();

const canAttempt = (ref) => {
  const last = lastAttempt.get(ref);
  return !last || Date.now() - last > NOT_FOUND_COOLDOWN_MS;
};

const staleBefore = () => new Date(Date.now() - STALE_MINUTES * 60 * 1000);

const reconcileOne = async (reference) => {
  if (!canAttempt(reference)) return { status: "cooldown", reference };
  try {
    const result = await PaymentService.reconcilePaymentByReference(reference);
    if (result?.status === "unverified") lastAttempt.set(reference, Date.now());
    else lastAttempt.delete(reference);
    return result;
  } catch (err) {
    // Flutterwave "not found"/network errors are expected for unpaid refs.
    lastAttempt.set(reference, Date.now());
    return { status: "error", reference, message: err.message };
  }
};

const runReconciliation = async () => {
  const cutoff = staleBefore();
  const references = new Set();

  const [deposits, repayments, minutes, memberships] = await Promise.all([
    Savings.find({
      type: "deposit",
      status: "pending",
      reference: /^DEP_/,
      createdAt: { $lt: cutoff },
    }).select("reference").limit(BATCH_LIMIT).lean(),
    Savings.find({
      type: "loan_repayment",
      status: "pending",
      reference: { $regex: "^(LRP|RPL)_" },
      createdAt: { $lt: cutoff },
    }).select("reference").limit(BATCH_LIMIT).lean(),
    Minutes.find({
      status: "pending",
      reference: /^MIN_/,
      createdAt: { $lt: cutoff },
    }).select("reference").limit(BATCH_LIMIT).lean(),
    User.find({
      membershipFeePaid: { $ne: true },
      membershipFeeTxRef: /^MEM_/,
    }).select("membershipFeeTxRef").limit(BATCH_LIMIT).lean(),
  ]);

  deposits.forEach((d) => d.reference && references.add(d.reference));
  repayments.forEach((r) => r.reference && references.add(r.reference));
  minutes.forEach((m) => m.reference && references.add(m.reference));
  memberships.forEach((u) => u.membershipFeeTxRef && references.add(u.membershipFeeTxRef));

  const outcomes = { scanned: references.size, reconciled: 0, pending: 0, failed: 0 };
  for (const ref of references) {
    const result = await reconcileOne(ref);
    if (result?.status === "reconciled") outcomes.reconciled += 1;
    else if (result?.status === "successful" || result?.status === "cooldown") outcomes.pending += 1;
    else if (["unverified", "error"].includes(result?.status)) outcomes.pending += 1;
    else outcomes.failed += 1;
  }
  return outcomes;
};

module.exports = { runReconciliation, reconcileOne };
