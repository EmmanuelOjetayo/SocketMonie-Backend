/**
 * Safe migration: set a separate historical display date for successful savings
 * deposit records so transaction history can reflect a six-month period
 * (2026-05-20 through 2026-11-20) without falsifying financial audit timestamps.
 *
 * IMPORTANT:
 * - Does NOT modify createdAt/updatedAt/paidAt/amount/reference/status/user/type/category.
 * - Does NOT touch SocketMinutes, membership, loan, withdrawal, failed, pending,
 *   abandoned, or any non-savings-deposit records.
 * - Targets only successful savings deposits:
 *     Savings:            type="deposit", status="completed", category != "minutes_payment"
 *     SavingsTransaction: type="deposit", status="completed" with reference matching
 *                         a targeted Savings deposit (corresponding twin record).
 * - Idempotent: records already tagged with this migration key are skipped.
 * - Dry-run by default. Requires --execute to write. Creates a backup export
 *   before applying changes. Supports rollback from that backup.
 *
 * Usage (from Backend/):
 *   node Scripts/migrateSavingsDepositHistoryDates.js                  # dry-run
 *   node Scripts/migrateSavingsDepositHistoryDates.js --execute        # apply (creates backup)
 *   node Scripts/migrateSavingsDepositHistoryDates.js --rollback <backup.json>
 *
 * Environment: uses MONGO_URL / MONGODB_URI / DATABASE_URL (same as backend).
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const User = require("../Models/UserModel");
const Savings = require("../Models/SavingsModel");
const SavingsTransaction = require("../Models/SavingsTransactionModel");
const { connectMongooseWithRetry, getMongoUri } = require("../Utilis/mongoAtlas");

const MIGRATION_KEY = "savings_deposit_history_display_v1";
const RANGE_START = new Date("2026-05-20T00:00:00.000Z");
const RANGE_END = new Date("2026-11-20T23:59:59.999Z");

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const ROLLBACK_IDX = argv.indexOf("--rollback");
const ROLLBACK_PATH = ROLLBACK_IDX >= 0 ? argv[ROLLBACK_IDX + 1] : null;
const DRY_RUN = !EXECUTE && !ROLLBACK_PATH;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function distributeDate(index, total) {
  const start = RANGE_START.getTime();
  const end = RANGE_END.getTime();
  if (total <= 1) return new Date(Math.floor((start + end) / 2));
  const ratio = index / (total - 1);
  return new Date(Math.floor(start + ratio * (end - start)));
}

function savingsTargetFilter(includeMigrated = false) {
  const base = {
    type: "deposit",
    status: "completed",
    category: { $ne: "minutes_payment" },
  };
  if (includeMigrated) return base;
  return {
    ...base,
    $or: [
      { historyDisplayMigration: { $exists: false } },
      { historyDisplayMigration: null },
      { historyDisplayMigration: { $ne: MIGRATION_KEY } },
    ],
  };
}

function serializeSavingsRecord(doc) {
  return {
    collection: "Savings",
    _id: String(doc._id),
    userId: doc.userId ? String(doc.userId) : null,
    reference: doc.reference || null,
    transactionId: doc.transactionId || null,
    amount: doc.amount,
    type: doc.type,
    category: doc.category ?? null,
    status: doc.status,
    method: doc.method ?? null,
    paidAt: toIso(doc.paidAt || doc.completedAt || null),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
    historyDisplayAt: toIso(doc.historyDisplayAt),
    historyDisplayMigration: doc.historyDisplayMigration || null,
  };
}

function serializeSavingsTxRecord(doc) {
  return {
    collection: "SavingsTransaction",
    _id: String(doc._id),
    userId: doc.userId ? String(doc.userId) : null,
    reference: doc.reference || null,
    transactionId: doc.transactionId || null,
    amount: doc.amount,
    type: doc.type,
    status: doc.status,
    method: doc.method ?? null,
    paidAt: toIso(doc.paidAt),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
    historyDisplayAt: toIso(doc.historyDisplayAt),
    historyDisplayMigration: doc.historyDisplayMigration || null,
  };
}

async function inspect() {
  const totalUsersInspected = await User.countDocuments({});
  const allSuccessfulSavingsDeposits = await Savings.find(savingsTargetFilter(true))
    .sort({ userId: 1, createdAt: 1, _id: 1 })
    .lean();
  const pendingSavingsDeposits = await Savings.find(savingsTargetFilter(false))
    .sort({ userId: 1, createdAt: 1, _id: 1 })
    .lean();

  const pendingReferences = pendingSavingsDeposits
    .map((d) => d.reference)
    .filter((r) => typeof r === "string" && r.length > 0);

  const pendingSavingsTx = pendingReferences.length
    ? await SavingsTransaction.find({
        type: "deposit",
        status: "completed",
        reference: { $in: pendingReferences },
        $or: [
          { historyDisplayMigration: { $exists: false } },
          { historyDisplayMigration: null },
          { historyDisplayMigration: { $ne: MIGRATION_KEY } },
        ],
      })
        .sort({ createdAt: 1, _id: 1 })
        .lean()
    : [];

  // Map reference -> proposed date from Savings plan (corresponding records must align)
  const proposedByReference = new Map();
  pendingSavingsDeposits.forEach((doc, index) => {
    const proposed = distributeDate(index, pendingSavingsDeposits.length);
    if (doc.reference) proposedByReference.set(doc.reference, proposed);
  });

  const savingsPlan = pendingSavingsDeposits.map((doc, index) => {
    const proposed = distributeDate(index, pendingSavingsDeposits.length);
    return {
      collection: "Savings",
      _id: String(doc._id),
      userId: doc.userId ? String(doc.userId) : null,
      reference: doc.reference || null,
      amount: doc.amount,
      status: doc.status,
      type: doc.type,
      category: doc.category ?? null,
      currentCreatedAt: toIso(doc.createdAt),
      currentHistoryDisplayAt: toIso(doc.historyDisplayAt),
      proposedHistoryDisplayAt: toIso(proposed),
    };
  });

  const savingsTxPlan = pendingSavingsTx.map((doc) => {
    const proposed =
      (doc.reference && proposedByReference.get(doc.reference)) ||
      distributeDate(0, 1);
    return {
      collection: "SavingsTransaction",
      _id: String(doc._id),
      userId: doc.userId ? String(doc.userId) : null,
      reference: doc.reference || null,
      amount: doc.amount,
      status: doc.status,
      type: doc.type,
      currentCreatedAt: toIso(doc.createdAt),
      currentPaidAt: toIso(doc.paidAt),
      currentHistoryDisplayAt: toIso(doc.historyDisplayAt),
      proposedHistoryDisplayAt: toIso(proposed),
    };
  });

  const affectedUserIds = new Set(
    pendingSavingsDeposits.map((d) => (d.userId ? String(d.userId) : null)).filter(Boolean)
  );

  return {
    migrationKey: MIGRATION_KEY,
    rangeStart: toIso(RANGE_START),
    rangeEnd: toIso(RANGE_END),
    totalUsersInspected,
    usersWithPendingSavingsDeposits: affectedUserIds.size,
    successfulSavingsDepositsFound: allSuccessfulSavingsDeposits.length,
    successfulSavingsDepositsAlreadyMigrated:
      allSuccessfulSavingsDeposits.length - pendingSavingsDeposits.length,
    pendingSavingsDepositRecords: pendingSavingsDeposits.length,
    pendingSavingsTransactionRecords: pendingSavingsTx.length,
    recordsThatWouldBeUpdated: pendingSavingsDeposits.length + pendingSavingsTx.length,
    pendingSavingsDeposits,
    pendingSavingsTx,
    savingsPlan,
    savingsTxPlan,
  };
}

function buildBackupPayload(inspection) {
  const savingsRecords = inspection.pendingSavingsDeposits.map(serializeSavingsRecord);
  const savingsTxRecords = inspection.pendingSavingsTx.map(serializeSavingsTxRecord);
  return {
    meta: {
      migrationKey: MIGRATION_KEY,
      createdAt: new Date().toISOString(),
      rangeStart: toIso(RANGE_START),
      rangeEnd: toIso(RANGE_END),
      mode: "pre-execute-backup",
      counts: {
        savings: savingsRecords.length,
        savingsTransactions: savingsTxRecords.length,
        total: savingsRecords.length + savingsTxRecords.length,
      },
    },
    records: [...savingsRecords, ...savingsTxRecords],
  };
}

async function executeMigration(inspection) {
  if (inspection.recordsThatWouldBeUpdated === 0) {
    return { backupPath: null, updatedSavings: 0, updatedSavingsTransactions: 0, note: "Nothing to update (idempotent)." };
  }

  const backupDir = path.join(__dirname, "..", "backups", "migrations");
  ensureDir(backupDir);
  const backupPath = path.join(
    backupDir,
    `savings-deposit-history-${Date.now()}.json`
  );
  const backupPayload = buildBackupPayload(inspection);
  fs.writeFileSync(backupPath, JSON.stringify(backupPayload, null, 2), "utf8");

  let updatedSavings = 0;
  let updatedSavingsTransactions = 0;

  for (let i = 0; i < inspection.pendingSavingsDeposits.length; i += 1) {
    const doc = inspection.pendingSavingsDeposits[i];
    const proposed = distributeDate(i, inspection.pendingSavingsDeposits.length);
    const res = await Savings.updateOne(
      { _id: doc._id, historyDisplayMigration: { $ne: MIGRATION_KEY } },
      { $set: { historyDisplayAt: proposed, historyDisplayMigration: MIGRATION_KEY } },
      { timestamps: false }
    );
    updatedSavings += res.modifiedCount || 0;
  }

  const proposedByReference = new Map();
  inspection.pendingSavingsDeposits.forEach((doc, index) => {
    if (doc.reference) proposedByReference.set(doc.reference, distributeDate(index, inspection.pendingSavingsDeposits.length));
  });

  for (const doc of inspection.pendingSavingsTx) {
    const proposed = (doc.reference && proposedByReference.get(doc.reference)) || distributeDate(0, 1);
    const res = await SavingsTransaction.updateOne(
      { _id: doc._id, historyDisplayMigration: { $ne: MIGRATION_KEY } },
      { $set: { historyDisplayAt: proposed, historyDisplayMigration: MIGRATION_KEY } },
      { timestamps: false }
    );
    updatedSavingsTransactions += res.modifiedCount || 0;
  }

  return { backupPath, updatedSavings, updatedSavingsTransactions };
}

async function rollback(backupPath) {
  const resolved = path.isAbsolute(backupPath) ? backupPath : path.join(process.cwd(), backupPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Backup file not found: ${resolved}`);
  }
  const payload = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const records = Array.isArray(payload.records) ? payload.records : [];
  let restoredSavings = 0;
  let restoredSavingsTransactions = 0;

  for (const rec of records) {
    const id = rec._id;
    const historyDisplayAt = rec.historyDisplayAt ? new Date(rec.historyDisplayAt) : null;
    const historyDisplayMigration = rec.historyDisplayMigration || null;
    const update = {
      $set: {
        historyDisplayAt,
        historyDisplayMigration,
      },
    };
    if (rec.collection === "Savings") {
      const res = await Savings.updateOne({ _id: id }, update, { timestamps: false });
      restoredSavings += res.modifiedCount || (res.matchedCount ? 1 : 0);
    } else if (rec.collection === "SavingsTransaction") {
      const res = await SavingsTransaction.updateOne({ _id: id }, update, { timestamps: false });
      restoredSavingsTransactions += res.modifiedCount || (res.matchedCount ? 1 : 0);
    }
  }

  return { backupPath: resolved, totalRecords: records.length, restoredSavings, restoredSavingsTransactions };
}

function printInspection(inspection) {
  console.log(JSON.stringify({
    migrationKey: inspection.migrationKey,
    rangeStart: inspection.rangeStart,
    rangeEnd: inspection.rangeEnd,
    totalUsersInspected: inspection.totalUsersInspected,
    usersWithPendingSavingsDeposits: inspection.usersWithPendingSavingsDeposits,
    successfulSavingsDepositsFound: inspection.successfulSavingsDepositsFound,
    successfulSavingsDepositsAlreadyMigrated: inspection.successfulSavingsDepositsAlreadyMigrated,
    pendingSavingsDepositRecords: inspection.pendingSavingsDepositRecords,
    pendingSavingsTransactionRecords: inspection.pendingSavingsTransactionRecords,
    recordsThatWouldBeUpdated: inspection.recordsThatWouldBeUpdated,
  }, null, 2));
}

async function main() {
  const mongoUrl = getMongoUri();
  console.log(`[MIGRATE] Connecting to configured MongoDB...`);
  await connectMongooseWithRetry(mongoose, mongoUrl, {}, { attempts: 5, delayMs: 1500 });

  try {
    if (ROLLBACK_PATH) {
      console.log(`[MIGRATE] Rollback mode: ${ROLLBACK_PATH}`);
      const result = await rollback(ROLLBACK_PATH);
      console.log(`[MIGRATE] Rollback complete:`, JSON.stringify(result, null, 2));
      return;
    }

    const inspection = await inspect();
    console.log(`[MIGRATE] Inspection summary (${DRY_RUN ? "dry-run" : "execute"}):`);
    printInspection(inspection);

    // Detailed plan (current/proposed timestamps) for auditability.
    const reportDir = path.join(__dirname, "..", "backups", "migrations");
    ensureDir(reportDir);
    const reportPath = path.join(reportDir, `savings-deposit-history-plan-${Date.now()}.json`);
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: DRY_RUN ? "dry-run" : "pre-execute-plan",
          summary: {
            migrationKey: inspection.migrationKey,
            rangeStart: inspection.rangeStart,
            rangeEnd: inspection.rangeEnd,
            totalUsersInspected: inspection.totalUsersInspected,
            usersWithPendingSavingsDeposits: inspection.usersWithPendingSavingsDeposits,
            successfulSavingsDepositsFound: inspection.successfulSavingsDepositsFound,
            successfulSavingsDepositsAlreadyMigrated: inspection.successfulSavingsDepositsAlreadyMigrated,
            pendingSavingsDepositRecords: inspection.pendingSavingsDepositRecords,
            pendingSavingsTransactionRecords: inspection.pendingSavingsTransactionRecords,
            recordsThatWouldBeUpdated: inspection.recordsThatWouldBeUpdated,
          },
          savingsPlan: inspection.savingsPlan,
          savingsTransactionPlan: inspection.savingsTxPlan,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`[MIGRATE] Detailed plan written: ${reportPath}`);

    if (DRY_RUN) {
      console.log("[MIGRATE] Dry-run complete. No database changes were made. Re-run with --execute to apply (a backup export will be created before writes).");
      return;
    }

    console.log("[MIGRATE] --execute provided. Creating backup and applying migration...");
    const result = await executeMigration(inspection);
    console.log(`[MIGRATE] Execution complete:`, JSON.stringify(result, null, 2));
    if (result.backupPath) {
      console.log(`[MIGRATE] Rollback command: node Scripts/migrateSavingsDepositHistoryDates.js --rollback "${result.backupPath}"`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[MIGRATE] Failed:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  MIGRATION_KEY,
  RANGE_START,
  RANGE_END,
  savingsTargetFilter,
  distributeDate,
  inspect,
  buildBackupPayload,
  executeMigration,
  rollback,
  main,
};
