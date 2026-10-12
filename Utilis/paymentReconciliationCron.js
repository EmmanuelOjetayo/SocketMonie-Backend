/**
 * Payment reconciliation cron — FALLBACK 2.
 *
 * Runs in-process on a schedule (default every 5 minutes) and sweeps
 * stale pending payment records so that a missed/delayed/rejected webhook
 * still resolves. All completion flows through the same idempotent
 * Flutterwave-verified handlers as the webhook, so retries are safe.
 *
 * Disabled by default in test environments via RECONCILE_ENABLED=false.
 */

const cron = require("node-cron");
const { runReconciliation } = require("../Services/PaymentReconciliationService");

const SCHEDULE = process.env.RECONCILE_CRON || "*/5 * * * *";
let task = null;

function startReconciliationCron() {
  if (task) return task;
  const enabled = String(process.env.RECONCILE_ENABLED ?? "true").toLowerCase() !== "false";
  if (!enabled || process.env.NODE_ENV === "test") {
    console.log("⏸️  Payment reconciliation cron disabled (RECONCILE_ENABLED=false).");
    return null;
  }
  task = cron.schedule(SCHEDULE, async () => {
    try {
      const outcomes = await runReconciliation();
      if (outcomes.scanned > 0) {
        console.log("🔁 Payment reconciliation sweep:", JSON.stringify(outcomes));
      }
    } catch (err) {
      console.error("❌ Payment reconciliation sweep failed:", err.message);
    }
  });
  console.log(`✅ Payment reconciliation cron scheduled (${SCHEDULE}).`);
  return task;
}

module.exports = { startReconciliationCron };
