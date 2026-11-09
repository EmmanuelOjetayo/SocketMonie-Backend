/**
 * Loan defaulter escalation cron — FALLBACK 1.
 *
 * Runs daily (default 03:00). Ensures overdue → warning → default →
 * restricted → recovery transitions occur even if no admin triggers the
 * manual endpoint. Idempotent — each stage is a state-guarded transition.
 */
const cron = require("node-cron");
const { runLoanDefaulterEscalation } = require("./loanDefaulterEngine");

const SCHEDULE = process.env.LOAN_DEFAULTER_CRON || "0 3 * * *";
let task = null;

function startLoanDefaulterCron() {
  if (task) return task;
  const enabled = String(process.env.LOAN_DEFAULTER_ENABLED ?? "true").toLowerCase() !== "false";
  if (!enabled || process.env.NODE_ENV === "test") {
    console.log("⏸️  Loan defaulter cron disabled (LOAN_DEFAULTER_ENABLED=false).");
    return null;
  }
  task = cron.schedule(SCHEDULE, async () => {
    try {
      const result = await runLoanDefaulterEscalation();
      console.log("🔁 Loan defaulter escalation:", JSON.stringify(result));
    } catch (err) {
      console.error("❌ Loan defaulter escalation failed:", err.message);
    }
  });
  console.log(`✅ Loan defaulter cron scheduled (${SCHEDULE}).`);
  return task;
}

module.exports = { startLoanDefaulterCron };
