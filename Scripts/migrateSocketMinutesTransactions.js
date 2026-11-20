/**
 * SocketMinutes transaction-type backfill
 *
 * Why this exists:
 * SocketMinutes checkouts are initialised as Savings records with
 *   type: "deposit", category: "minutes_payment"
 * so the same webhook/reconciliation pipeline can settle them. Once a
 * dedicated MinuteTransaction twin is written at settlement, the unified
 * transaction history surfaces the record as "SocketMinutes Contribution".
 *
 * Older or misrouted rows may still live only inside Savings, so the
 * unified history could surface them as a savings deposit. This script
 * adds the missing MinuteTransaction twin without altering the Savings
 * ledger. It is idempotent and can be run any number of times.
 *
 * Usage:
 *   node Scripts/migrateSocketMinutesTransactions.js           (dry-run, prints what would change)
 *   node Scripts/migrateSocketMinutesTransactions.js --apply   (applies the backfill)
 *
 * Environment:
 *   Uses the same MONGO_URL / DATABASE_URL as the backend.
 */
const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Savings = require("../Models/SavingsModel");
const MinuteTransaction = require("../Models/MinuteTransactionModel");
const { recordMinuteTransaction } = require("../Services/TransactionService");
const { connectMongooseWithRetry, getMongoUri } = require("../Utilis/mongoAtlas");

const APPLY = process.argv.includes("--apply");
const MONGO_URL = getMongoUri();

(async () => {
  await connectMongooseWithRetry(mongoose, MONGO_URL, {}, { attempts: 5, delayMs: 1500 });

  const minutesSavings = await Savings.find({ category: "minutes_payment" }).sort({ createdAt: 1 }).lean();
  console.log(`[MIGRATE] Found ${minutesSavings.length} Savings row(s) with category "minutes_payment".`);

  let created = 0;
  let alreadyPresent = 0;
  let skippedPending = 0;

  for (const row of minutesSavings) {
    if (row.status !== "completed") {
      skippedPending++;
      continue;
    }
    if (!row.reference) {
      console.log(`[MIGRATE] Skipping row ${row._id} (${row.reference || "no reference"}) - no reference, cannot safely map.`);
      continue;
    }
    const existing = await MinuteTransaction.findOne({ reference: row.reference }).lean();
    if (existing) {
      alreadyPresent++;
      continue;
    }
    if (!APPLY) {
      console.log(`[MIGRATE dry-run] Would create MinuteTransaction twin for ref ${row.reference} | amount ${row.amount} | txId ${row.transactionId || "n/a"}`);
      created++;
      continue;
    }
    await recordMinuteTransaction({
      userId: row.userId,
      reference: row.reference,
      transactionId: row.transactionId ? String(row.transactionId) : null,
      amount: Number(row.amount || 0),
      currency: "NGN",
      status: "completed",
      method: row.method || "flutterwave",
      paidAt: row.completedAt || row.updatedAt || row.createdAt || new Date(),
      metadata: {
        source: "migration:socketMinutesBackfill",
        originalType: row.type,
      },
    });
    created++;
  }

  console.log(`[MIGRATE] Done. Backfilled: ${created} | already present: ${alreadyPresent} | skipped (not completed): ${skippedPending}${APPLY ? "" : " (dry-run, use --apply to write)"}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("[MIGRATE] failed:", e?.message || e);
  process.exit(1);
});
