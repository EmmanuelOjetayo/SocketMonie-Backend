/**
 * SocketScore monthly finalization cron.
 *
 * Runs on the 1st of every month (02:00 server time) and finalises the
 * PREVIOUS completed calendar month for every member — exactly once per
 * member per month (the service upserts by member+year+month and is
 * idempotent, so duplicate runs can never double-count).
 *
 * Disabled by default in test environments via SCORE_CRON_ENABLED=false.
 */

const cron = require("node-cron");
const { finalizeAllDueMembers } = require("../Services/SocketScoreService");

const SCHEDULE = process.env.SCORE_CRON || "0 2 1 * *";
let task = null;

function startSocketScoreCron() {
  if (task) return task;
  const enabled = String(process.env.SCORE_CRON_ENABLED ?? "true").toLowerCase() !== "false";
  if (!enabled || process.env.NODE_ENV === "test") {
    console.log("⏸️  SocketScore cron disabled (SCORE_CRON_ENABLED=false).");
    return null;
  }
  task = cron.schedule(SCHEDULE, async () => {
    try {
      const outcomes = await finalizeAllDueMembers({ trigger: "cron" });
      console.log("🏆 SocketScore monthly finalization sweep:", JSON.stringify(outcomes));
    } catch (err) {
      console.error("❌ SocketScore monthly finalization failed:", err.message);
    }
  });
  console.log(`✅ SocketScore monthly finalization cron scheduled (${SCHEDULE}).`);
  return task;
}

module.exports = { startSocketScoreCron };
