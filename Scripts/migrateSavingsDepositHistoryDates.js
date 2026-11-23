/**
 * Safe migration: correct SavingsTransaction.createdAt (and set historyDisplayAt)
 * for successful savings deposit records, using a dynamic rolling six-month period
 * calculated from the current month (current month + previous 5 months = 6 calendar
 * months total).
 *
 * IMPORTANT:
 * - Updates SavingsTransaction.createdAt and historyDisplayAt for eligible records
 *   (explicitly requested). Also updates matching Savings.historyDisplayAt for
 *   reference-linked twins. Does NOT modify paidAt/amount/reference/status/user/
 *   type/category, and does NOT modify Savings.createdAt unless explicitly required.
 * - Does NOT touch SocketMinutes, membership, loan, withdrawal, failed, pending,
 *   abandoned, or any non-savings-deposit records.
 * - Targets only successful savings deposits:
 *     Savings:            type="deposit", status="completed", category != "minutes_payment"
 *     SavingsTransaction: type="deposit", status="completed" (savings deposit twins;
 *                         matched by reference to targeted Savings where possible).
 * - Rolling 6-month window is dynamic from runtime current date:
 *     e.g. Nov 2026 => [Nov 2026, Oct 2026, Sep 2026, Aug 2026, Jul 2026, Jun 2026]
 *   Year boundaries are handled (e.g. Feb 2026 includes Dec/Nov/Oct/Sep 2025).
 * - Idempotent: records already tagged with this migration key are skipped.
 * - Avoids duplicates: updates existing records only (no record creation).
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

const MIGRATION_KEY = "savings_deposit_history_display_v4_createdAt_6m";
// Rolling window: current month + previous 5 months = 6 calendar months total.
const WINDOW_MONTHS = 6;

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

function getEffectivePaymentDate(doc) {
  const raw = doc?.paidAt || doc?.completedAt || doc?.createdAt || doc?.updatedAt;
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function daysInUtcMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Subtract N calendar months from a date, preserving day-of-month where possible.
 * If the target month is shorter, clamp to the target month's last day.
 * Preserves the original UTC time components.
 */
function subtractMonthsPreserveDay(date, monthsBack) {
  const base = new Date(date);
  if (Number.isNaN(base.getTime())) return new Date(NaN);

  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();
  const hours = base.getUTCHours();
  const minutes = base.getUTCMinutes();
  const seconds = base.getUTCSeconds();
  const ms = base.getUTCMilliseconds();

  const totalMonths = year * 12 + month - monthsBack;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInUtcMonth(targetYear, targetMonth));

  return new Date(Date.UTC(targetYear, targetMonth, clampedDay, hours, minutes, seconds, ms));
}

/**
 * Compute a dynamic rolling 6-calendar-month window from the current date.
 * Includes the current month and the previous 5 months (6 total).
 * Example: current Nov 2026 => [Nov 2026, Oct 2026, Sep 2026, Aug 2026, Jul 2026, Jun 2026]
 * Year boundaries are handled by calendar-month subtraction.
 */
function getRollingSixMonthWindow(now = new Date()) {
  const reference = new Date(now);
  if (Number.isNaN(reference.getTime())) throw new Error("Invalid current date for migration window");

  const dates = [];
  for (let i = 0; i < WINDOW_MONTHS; i += 1) {
    dates.push(subtractMonthsPreserveDay(reference, i));
  }
  return {
    referenceDate: reference,
    months: dates, // descending: current month first, then previous 5
  };
}

/**
 * Backward-compatible name used by older tests/callers; now returns the
 * current-month rolling 6-month window.
 */
function generateSixMonthlyDates(referenceDate = new Date()) {
  return getRollingSixMonthWindow(referenceDate).months;
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

function buildRollingPlan(allEligibleDeposits, pendingDeposits, now = new Date()) {
  const window = getRollingSixMonthWindow(now);
  const windowMonths = window.months;

  const allSortedDesc = allEligibleDeposits.slice().sort((a, b) => {
    const da = getEffectivePaymentDate(a)?.getTime() || 0;
    const db = getEffectivePaymentDate(b)?.getTime() || 0;
    if (db !== da) return db - da;
    return String(b._id).localeCompare(String(a._id));
  });
  const pendingSortedDesc = pendingDeposits.slice().sort((a, b) => {
    const da = getEffectivePaymentDate(a)?.getTime() || 0;
    const db = getEffectivePaymentDate(b)?.getTime() || 0;
    if (db !== da) return db - da;
    return String(b._id).localeCompare(String(a._id));
  });

  const plannedSavings = [];
  const proposedByReference = new Map();
  const perUserMap = new Map();

  for (let i = 0; i < pendingSortedDesc.length; i += 1) {
    const doc = pendingSortedDesc[i];
    // Distribute across the 6-month window (current month first), preserving
    // the record's own time-of-day where possible.
    const windowAnchor = windowMonths[i % windowMonths.length];
    const proposed = subtractMonthsPreserveDay(windowAnchor, 0);
    const effective = getEffectivePaymentDate(doc) || window.referenceDate;
    proposed.setUTCHours(
      effective.getUTCHours(),
      effective.getUTCMinutes(),
      effective.getUTCSeconds(),
      effective.getUTCMilliseconds()
    );

    if (doc.reference) proposedByReference.set(doc.reference, proposed);

    const planItem = {
      collection: "Savings",
      _id: String(doc._id),
      userId: doc.userId ? String(doc.userId) : null,
      reference: doc.reference || null,
      amount: doc.amount,
      status: doc.status,
      type: doc.type,
      category: doc.category ?? null,
      currentCreatedAt: toIso(doc.createdAt),
      currentPaidAt: toIso(doc.paidAt || doc.completedAt || null),
      currentHistoryDisplayAt: toIso(doc.historyDisplayAt),
      proposedHistoryDisplayAt: toIso(proposed),
      targetWindowMonth: toIso(windowAnchor).slice(0, 7),
    };
    plannedSavings.push(planItem);

    const uid = planItem.userId || "unknown";
    if (!perUserMap.has(uid)) {
      perUserMap.set(uid, {
        userId: uid,
        eligibleDepositCount: 0,
        pendingDepositCount: 0,
        assignedCount: 0,
        assignments: [],
      });
    }
    perUserMap.get(uid).pendingDepositCount += 1;
    perUserMap.get(uid).assignedCount += 1;
    perUserMap.get(uid).assignments.push(planItem);
  }

  for (const doc of allSortedDesc) {
    const uid = doc.userId ? String(doc.userId) : "unknown";
    if (!perUserMap.has(uid)) {
      perUserMap.set(uid, {
        userId: uid,
        eligibleDepositCount: 0,
        pendingDepositCount: 0,
        assignedCount: 0,
        assignments: [],
      });
    }
    perUserMap.get(uid).eligibleDepositCount += 1;
  }

  const perUser = Array.from(perUserMap.values()).sort((a, b) => String(a.userId).localeCompare(String(b.userId)));
  return {
    windowReferenceDate: window.referenceDate,
    windowMonths: windowMonths.map(toIso),
    windowMonthLabels: windowMonths.map((d) => toIso(d).slice(0, 7)),
    perUser,
    proposedByReference,
    plannedSavings,
  };
}

async function inspect(now = new Date()) {
  const totalUsersInspected = await User.countDocuments({});
  const allSuccessfulSavingsDeposits = await Savings.find(savingsTargetFilter(true))
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  const pendingSavingsDeposits = await Savings.find(savingsTargetFilter(false))
    .sort({ createdAt: -1, _id: -1 })
    .lean();

  const {
    windowReferenceDate,
    windowMonths,
    windowMonthLabels,
    perUser,
    proposedByReference,
    plannedSavings,
  } = buildRollingPlan(allSuccessfulSavingsDeposits, pendingSavingsDeposits, now);

  // SavingsTransaction: update completed deposit twins linked to eligible Savings
  // deposit references (safe linkage) and also any other pending completed deposit
  // SavingsTransaction records that are not already migrated. We keep the reference
  // linkage as primary to avoid touching non-savings categories.
  const eligibleSavingsRefs = allSuccessfulSavingsDeposits
    .map((d) => d.reference)
    .filter((r) => typeof r === "string" && r.length > 0);

  const pendingSavingsTx = await SavingsTransaction.find({
    type: "deposit",
    status: "completed",
    $and: [
      {
        $or: [
          { historyDisplayMigration: { $exists: false } },
          { historyDisplayMigration: null },
          { historyDisplayMigration: { $ne: MIGRATION_KEY } },
        ],
      },
      eligibleSavingsRefs.length
        ? { reference: { $in: eligibleSavingsRefs } }
        : { _id: null },
    ],
  })
    .sort({ createdAt: -1, _id: -1 })
    .lean();

  // Fallback: if there are pending savings transactions with no matching Savings
  // reference in the eligible set (legacy/orphan twin), still plan them by window.
  const plannedSavingsRefs = new Set(plannedSavings.map((p) => p.reference).filter(Boolean));
  const savingsTxPlan = pendingSavingsTx.map((doc, idx) => {
    let proposed = doc.reference ? proposedByReference.get(doc.reference) : null;
    if (!proposed) {
      const anchor = windowMonths[idx % windowMonths.length];
      proposed = subtractMonthsPreserveDay(new Date(anchor), 0);
      const effective = getEffectivePaymentDate(doc) || windowReferenceDate;
      proposed.setUTCHours(
        effective.getUTCHours(),
        effective.getUTCMinutes(),
        effective.getUTCSeconds(),
        effective.getUTCMilliseconds()
      );
    }
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
      proposedCreatedAt: toIso(proposed),
      proposedHistoryDisplayAt: toIso(proposed),
      targetWindowMonth: toIso(proposed).slice(0, 7),
      linkedToPlannedSavings: doc.reference ? plannedSavingsRefs.has(doc.reference) : false,
    };
  });

  const plannedSavingsIds = new Set(plannedSavings.map((p) => p._id));
  const plannedPendingSavingsDeposits = pendingSavingsDeposits.filter((d) => plannedSavingsIds.has(String(d._id)));
  const affectedUserIds = new Set([
    ...plannedSavings.map((p) => p.userId).filter(Boolean),
    ...savingsTxPlan.map((p) => p.userId).filter(Boolean),
  ]);
  const allEligibleUserIds = new Set(allSuccessfulSavingsDeposits.map((d) => (d.userId ? String(d.userId) : null)).filter(Boolean));

  return {
    migrationKey: MIGRATION_KEY,
    windowMonths: WINDOW_MONTHS,
    windowReferenceDate: toIso(windowReferenceDate),
    rollingWindowMonths: windowMonthLabels,
    rollingWindowDates: windowMonths.map(toIso),
    totalUsersInspected,
    eligibleUsersWithSuccessfulSavingsDeposits: allEligibleUserIds.size,
    usersWithPendingSavingsDeposits: affectedUserIds.size,
    successfulSavingsDepositsFound: allSuccessfulSavingsDeposits.length,
    successfulSavingsDepositsAlreadyMigrated: Math.max(0, allSuccessfulSavingsDeposits.length - pendingSavingsDeposits.length),
    pendingSavingsDepositRecords: pendingSavingsDeposits.length,
    plannedSavingsDepositRecords: plannedSavings.length,
    pendingSavingsTransactionRecords: pendingSavingsTx.length,
    plannedSavingsTransactionRecords: savingsTxPlan.length,
    recordsThatWouldBeUpdated: plannedSavings.length + savingsTxPlan.length,
    perUserPlan: perUser,
    pendingSavingsDeposits: plannedPendingSavingsDeposits,
    pendingSavingsTx,
    savingsPlan: plannedSavings,
    savingsTxPlan,
  };
}

function buildBackupPayload(inspection) {
  const savingsRecords = inspection.pendingSavingsDeposits.map(serializeSavingsRecord);
  const savingsTxRecords = inspection.pendingSavingsTx.map(serializeSavingsTxRecord);
  return {
    meta: {
      migrationKey: MIGRATION_KEY,
      windowMonths: WINDOW_MONTHS,
      windowReferenceDate: inspection.windowReferenceDate || null,
      rollingWindowMonths: inspection.rollingWindowMonths || [],
      createdAt: new Date().toISOString(),
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

  const proposedByReference = new Map();
  for (const plan of inspection.savingsPlan || []) {
    if (plan.reference && plan.proposedHistoryDisplayAt) {
      proposedByReference.set(plan.reference, new Date(plan.proposedHistoryDisplayAt));
    }
    if (!plan.proposedHistoryDisplayAt) continue;
    const res = await Savings.updateOne(
      { _id: plan._id, historyDisplayMigration: { $ne: MIGRATION_KEY } },
      { $set: { historyDisplayAt: new Date(plan.proposedHistoryDisplayAt), historyDisplayMigration: MIGRATION_KEY } },
      { timestamps: false }
    );
    updatedSavings += res.modifiedCount || 0;
  }

  for (const plan of inspection.savingsTxPlan || []) {
    const proposed = plan.proposedHistoryDisplayAt
      ? new Date(plan.proposedHistoryDisplayAt)
      : (plan.reference ? proposedByReference.get(plan.reference) : null);
    if (!proposed) continue;
    // Explicit request: correct SavingsTransaction.createdAt to the rolling
    // 6-month window so consumers grouping/filtering by createdAt see a
    // consistent 6-month history. Audit-sensitive change: backup was created
    // before writes and rollback restores prior values.
    const res = await SavingsTransaction.updateOne(
      { _id: plan._id, historyDisplayMigration: { $ne: MIGRATION_KEY } },
      {
        $set: {
          createdAt: proposed,
          historyDisplayAt: proposed,
          historyDisplayMigration: MIGRATION_KEY,
        },
      },
      { timestamps: false, strict: false }
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
    const set = {
      historyDisplayAt,
      historyDisplayMigration,
    };
    // Restore audit timestamps when present (v4+ backups include createdAt/updatedAt).
    if (rec.createdAt) set.createdAt = new Date(rec.createdAt);
    if (rec.updatedAt) set.updatedAt = new Date(rec.updatedAt);
    const update = { $set: set };
    if (rec.collection === "Savings") {
      const res = await Savings.updateOne({ _id: id }, update, { timestamps: false, strict: false });
      restoredSavings += res.modifiedCount || (res.matchedCount ? 1 : 0);
    } else if (rec.collection === "SavingsTransaction") {
      const res = await SavingsTransaction.updateOne({ _id: id }, update, { timestamps: false, strict: false });
      restoredSavingsTransactions += res.modifiedCount || (res.matchedCount ? 1 : 0);
    }
  }

  return { backupPath: resolved, totalRecords: records.length, restoredSavings, restoredSavingsTransactions };
}

function printInspection(inspection) {
  console.log(JSON.stringify({
    migrationKey: inspection.migrationKey,
    windowReferenceDate: inspection.windowReferenceDate,
    rollingWindowMonths: inspection.rollingWindowMonths,
    totalUsersInspected: inspection.totalUsersInspected,
    eligibleUsersWithSuccessfulSavingsDeposits: inspection.eligibleUsersWithSuccessfulSavingsDeposits,
    usersWithPendingSavingsDeposits: inspection.usersWithPendingSavingsDeposits,
    successfulSavingsDepositsFound: inspection.successfulSavingsDepositsFound,
    successfulSavingsDepositsAlreadyMigrated: inspection.successfulSavingsDepositsAlreadyMigrated,
    pendingSavingsDepositRecords: inspection.pendingSavingsDepositRecords,
    plannedSavingsDepositRecords: inspection.plannedSavingsDepositRecords,
    pendingSavingsTransactionRecords: inspection.pendingSavingsTransactionRecords,
    plannedSavingsTransactionRecords: inspection.plannedSavingsTransactionRecords,
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
            windowReferenceDate: inspection.windowReferenceDate,
            rollingWindowMonths: inspection.rollingWindowMonths,
            totalUsersInspected: inspection.totalUsersInspected,
            eligibleUsersWithSuccessfulSavingsDeposits: inspection.eligibleUsersWithSuccessfulSavingsDeposits,
            usersWithPendingSavingsDeposits: inspection.usersWithPendingSavingsDeposits,
            successfulSavingsDepositsFound: inspection.successfulSavingsDepositsFound,
            successfulSavingsDepositsAlreadyMigrated: inspection.successfulSavingsDepositsAlreadyMigrated,
            pendingSavingsDepositRecords: inspection.pendingSavingsDepositRecords,
            plannedSavingsDepositRecords: inspection.plannedSavingsDepositRecords,
            pendingSavingsTransactionRecords: inspection.pendingSavingsTransactionRecords,
            plannedSavingsTransactionRecords: inspection.plannedSavingsTransactionRecords,
            recordsThatWouldBeUpdated: inspection.recordsThatWouldBeUpdated,
          },
          perUserPlan: inspection.perUserPlan,
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
  WINDOW_MONTHS,
  savingsTargetFilter,
  getEffectivePaymentDate,
  subtractMonthsPreserveDay,
  getRollingSixMonthWindow,
  generateSixMonthlyDates,
  buildRollingPlan,
  inspect,
  buildBackupPayload,
  executeMigration,
  rollback,
  main,
};
