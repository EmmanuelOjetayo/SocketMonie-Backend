const mongoose = require("mongoose");
const dotenv = require("dotenv");
const { ensureNullableUniqueIndexes } = require("../Utilis/indexMigrations");
const { configureMongoDns, getMongoUri, connectMongooseWithRetry } = require("../Utilis/mongoAtlas");

dotenv.config({ path: require("path").join(__dirname, "../.env") });

// Apply defensive DNS settings as early as possible for Atlas/SRV lookups.
configureMongoDns();

async function db() {
  const uri = getMongoUri();
  await connectMongooseWithRetry(mongoose, uri, {}, { attempts: 5, delayMs: 1500 });
  console.log("Database connected Successfully");

  // Self-healing index migration: nullable unique fields must be
  // protected by a PARTIAL unique index (sparse alone does not exclude
  // `null`, which made the second such document fail with E11000).
  try {
    await ensureNullableUniqueIndexes(mongoose.connection.db);
  } catch (migrationError) {
    console.error("Index migration failed:", migrationError.message);
  }
}

module.exports = db;
