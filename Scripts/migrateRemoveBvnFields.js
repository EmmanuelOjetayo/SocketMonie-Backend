/**
 * Safe migration: remove the legacy `bvn` field from existing user documents.
 *
 * IMPORTANT:
 * - Targets ONLY documents where the `bvn` path exists.
 * - Uses `$unset: { bvn: "" }`; no other user field is modified or deleted.
 * - Dry-run by default. Requires `--execute` to write.
 * - Creates a backup export BEFORE any write, and supports rollback from it.
 * - Idempotent: documents without `bvn` are skipped.
 * - Uses the native collection so the field can be removed even though it no
 *   longer exists on the Mongoose schema.
 *
 * Usage (from Backend/):
 *   node Scripts/migrateRemoveBvnFields.js                         # dry-run
 *   node Scripts/migrateRemoveBvnFields.js --execute               # apply (creates backup)
 *   node Scripts/migrateRemoveBvnFields.js --rollback <backup.json>
 *
 * Environment: uses MONGO_URL / MONGODB_URI / DATABASE_URL (same as backend).
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const User = require("../Models/UserModel");
const { connectMongooseWithRetry, getMongoUri } = require("../Utilis/mongoAtlas");

const MIGRATION_KEY = "remove_legacy_bvn_field_v1";
const BVN_PATH = "bvn";

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const ROLLBACK_IDX = argv.indexOf("--rollback");
const ROLLBACK_PATH = ROLLBACK_IDX >= 0 ? argv[ROLLBACK_IDX + 1] : null;
const DRY_RUN = !EXECUTE && !ROLLBACK_PATH;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function backupDir() {
  return path.join(__dirname, "..", "backups", "migrations");
}

function maskBvn(value) {
  if (value === null || value === undefined || value === "") return null;
  const digits = String(value);
  return `********${digits.slice(-4)}`;
}

function toObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  return new mongoose.Types.ObjectId(String(value));
}

async function inspect() {
  const collection = User.collection;
  const totalUsersInspected = await collection.countDocuments({});
  const docs = await collection
    .find({ [BVN_PATH]: { $exists: true } })
    .sort({ _id: 1 })
    .toArray();

  const records = docs.map((doc) => ({
    _id: String(doc._id),
    hadBvn: true,
    bvn: doc[BVN_PATH] ?? null,
    bvnMasked: maskBvn(doc[BVN_PATH]),
    isEmpty: doc[BVN_PATH] === null || doc[BVN_PATH] === "",
  }));

  return {
    migrationKey: MIGRATION_KEY,
    totalUsersInspected,
    usersWithBvnField: records.length,
    nonEmptyBvnCount: records.filter((r) => !r.isEmpty).length,
    emptyBvnCount: records.filter((r) => r.isEmpty).length,
    recordsThatWouldBeUpdated: records.length,
    records,
  };
}

function buildBackupPayload(inspection) {
  return {
    meta: {
      migrationKey: MIGRATION_KEY,
      createdAt: new Date().toISOString(),
      mode: "pre-execute-backup",
      containsSensitiveBvnValues: true,
      counts: {
        usersWithBvnField: inspection.usersWithBvnField,
        total: inspection.records.length,
      },
    },
    records: inspection.records.map((r) => ({
      _id: r._id,
      hadBvn: r.hadBvn,
      bvn: r.bvn,
    })),
  };
}

async function executeMigration(inspection) {
  if (inspection.recordsThatWouldBeUpdated === 0) {
    return {
      backupPath: null,
      updatedUsers: 0,
      note: "Nothing to update (idempotent).",
    };
  }

  ensureDir(backupDir());
  const backupPath = path.join(backupDir(), `remove-bvn-fields-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(buildBackupPayload(inspection), null, 2), "utf8");

  const collection = User.collection;
  let updatedUsers = 0;
  for (const rec of inspection.records) {
    const res = await collection.updateOne(
      { _id: toObjectId(rec._id), [BVN_PATH]: { $exists: true } },
      { $unset: { [BVN_PATH]: "" } },
      { timestamps: false }
    );
    updatedUsers += res.modifiedCount || 0;
  }

  return { backupPath, updatedUsers };
}

async function rollback(backupPath) {
  const resolved = path.isAbsolute(backupPath) ? backupPath : path.join(process.cwd(), backupPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Backup file not found: ${resolved}`);
  }

  const payload = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (payload?.meta?.migrationKey && payload.meta.migrationKey !== MIGRATION_KEY) {
    throw new Error(
      `Backup migrationKey mismatch: expected ${MIGRATION_KEY}, got ${payload.meta.migrationKey}`
    );
  }
  if (!Array.isArray(payload.records)) {
    throw new Error("Backup file has no records array");
  }

  const collection = User.collection;
  let restoredUsers = 0;
  let unsetUsers = 0;

  for (const rec of payload.records) {
    if (!rec?._id) continue;
    const filter = { _id: toObjectId(rec._id) };
    if (rec.hadBvn === false) {
      const res = await collection.updateOne(filter, { $unset: { [BVN_PATH]: "" } }, { timestamps: false });
      unsetUsers += res.modifiedCount || 0;
      continue;
    }

    const res = await collection.updateOne(
      filter,
      { $set: { [BVN_PATH]: rec.bvn ?? null } },
      { timestamps: false }
    );
    restoredUsers += res.modifiedCount || (res.matchedCount ? 1 : 0);
  }

  return {
    backupPath: resolved,
    totalRecords: payload.records.length,
    restoredUsers,
    unsetUsers,
  };
}

function printInspection(inspection) {
  console.log(
    JSON.stringify(
      {
        migrationKey: inspection.migrationKey,
        totalUsersInspected: inspection.totalUsersInspected,
        usersWithBvnField: inspection.usersWithBvnField,
        nonEmptyBvnCount: inspection.nonEmptyBvnCount,
        emptyBvnCount: inspection.emptyBvnCount,
        recordsThatWouldBeUpdated: inspection.recordsThatWouldBeUpdated,
      },
      null,
      2
    )
  );
}

async function main() {
  const mongoUrl = getMongoUri();
  console.log("[MIGRATE] Connecting to configured MongoDB...");
  await connectMongooseWithRetry(mongoose, mongoUrl, {}, { attempts: 5, delayMs: 1500 });

  try {
    if (ROLLBACK_PATH) {
      console.log(`[MIGRATE] Rollback mode: ${ROLLBACK_PATH}`);
      const result = await rollback(ROLLBACK_PATH);
      console.log("[MIGRATE] Rollback complete:", JSON.stringify(result, null, 2));
      return;
    }

    const inspection = await inspect();
    console.log(`[MIGRATE] Inspection summary (${DRY_RUN ? "dry-run" : "execute"}):`);
    printInspection(inspection);

    ensureDir(backupDir());
    const planPath = path.join(backupDir(), `remove-bvn-fields-plan-${Date.now()}.json`);
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: DRY_RUN ? "dry-run" : "pre-execute-plan",
          summary: {
            migrationKey: inspection.migrationKey,
            totalUsersInspected: inspection.totalUsersInspected,
            usersWithBvnField: inspection.usersWithBvnField,
            nonEmptyBvnCount: inspection.nonEmptyBvnCount,
            emptyBvnCount: inspection.emptyBvnCount,
            recordsThatWouldBeUpdated: inspection.recordsThatWouldBeUpdated,
          },
          records: inspection.records.map(({ _id, bvnMasked, isEmpty }) => ({
            _id,
            bvnMasked,
            isEmpty,
          })),
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`[MIGRATE] Detailed plan written: ${planPath}`);

    if (DRY_RUN) {
      console.log(
        "[MIGRATE] Dry-run complete. No database changes were made. Re-run with --execute to apply (a backup export will be created before writes)."
      );
      return;
    }

    console.log("[MIGRATE] --execute provided. Creating backup and removing legacy BVN fields...");
    const result = await executeMigration(inspection);
    console.log("[MIGRATE] Execution complete:", JSON.stringify(result, null, 2));
    if (result.backupPath) {
      console.log(
        `[MIGRATE] Rollback command: node Scripts/migrateRemoveBvnFields.js --rollback "${result.backupPath}"`
      );
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
  BVN_PATH,
  inspect,
  buildBackupPayload,
  executeMigration,
  rollback,
  main,
};
