/**
 * Index migrations.
 *
 * WHY THIS EXISTS
 * ---------------
 * `sparse: true` on a unique index only excludes documents where the field is
 * MISSING. It does NOT exclude documents where the field is present but
 * `null`. Every one of the fields below is declared with `default: null`, so
 * the field is always present and always `null` until it is filled in.
 *
 * The result: the SECOND document that has no value for the field violates
 * the unique index and MongoDB rejects the insert with
 *   E11000 duplicate key error ... dup key: { <field>: null }
 * which surfaced as HTTP 500 on savings deposits, minutes checkouts and
 * withdrawal records ("Internal Server Error" for the member).
 *
 * THE FIX
 * -------
 * A PARTIAL unique index (`partialFilterExpression: { <field>: { $type:
 * "string" } }`) indexes only documents that carry a real string value:
 *   - documents with the field missing or null are excluded -> no more
 *     null-vs-null collisions;
 *   - two documents with the SAME real value are still rejected -> the
 *     duplicate-reference / duplicate-transaction guarantee is preserved.
 *
 * NOTE: MongoDB refuses to combine `sparse` with `partialFilterExpression`
 * ("cannot mix partialFilterExpression and sparse options"), so the partial
 * filter replaces sparse entirely — it covers the same missing-field case.
 *
 * The migration is safe and idempotent:
 *   - it never touches collections/fields that are already migrated;
 *   - it refuses to migrate when duplicate real values exist (that would make
 *     the new unique index impossible to build) and logs the conflict;
 *   - it recreates the legacy index if building the new one fails, so the
 *     collection is never left without its uniqueness guard.
 */

const TARGETS = [
  { collection: "savings", field: "reference" },
  { collection: "savings", field: "transactionId" },
  { collection: "recoverypayments", field: "providerReference" },
];

const indexOptionsFor = (field) => ({
  unique: true,
  partialFilterExpression: { [field]: { $type: "string" } },
  name: `${field}_1`,
});

const findLegacyIndex = (indexes, field) =>
  indexes.find(
    (idx) =>
      idx.key &&
      Object.keys(idx.key).length === 1 &&
      idx.key[field] === 1 &&
      idx.unique === true &&
      !idx.partialFilterExpression
  );

const hasDuplicateValues = async (collection, field) => {
  const duplicates = await collection
    .aggregate([
      { $match: { [field]: { $type: "string" } } },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ])
    .toArray();
  return duplicates.length > 0;
};

/**
 * Ensures every nullable-unique field listed in TARGETS is protected by a
 * partial unique index. Safe to run on every boot: already-migrated
 * collections are detected and skipped.
 */
const ensureNullableUniqueIndexes = async (db, logger = console) => {
  const existingCollections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
  );

  for (const { collection: collectionName, field } of TARGETS) {
    if (!existingCollections.has(collectionName)) continue;

    const collection = db.collection(collectionName);

    try {
      const indexes = await collection.indexes();
      const legacy = findLegacyIndex(indexes, field);

      if (!legacy) {
        // Either no index yet, or already the partial one -> make sure the
        // partial index exists with the exact same options the schema uses.
        const partial = indexes.find(
          (idx) =>
            idx.key &&
            Object.keys(idx.key).length === 1 &&
            idx.key[field] === 1 &&
            idx.unique === true &&
            idx.partialFilterExpression
        );
        if (!partial) {
          await collection.createIndex({ [field]: 1 }, indexOptionsFor(field));
          logger.log?.(`[index-migration] created partial unique index ${collectionName}.${field}_1`);
        }
        continue;
      }

      if (await hasDuplicateValues(collection, field)) {
        logger.error?.(
          `[index-migration] SKIPPED ${collectionName}.${field}: duplicate values exist, ` +
            "the partial unique index cannot be built until they are resolved."
        );
        continue;
      }

      await collection.dropIndex(legacy.name);
      try {
        await collection.createIndex({ [field]: 1 }, indexOptionsFor(field));
        logger.log?.(
          `[index-migration] migrated ${collectionName}.${field}_1 from sparse to partial unique`
        );
      } catch (createError) {
        // Never leave the collection without its uniqueness guard.
        await collection.createIndex({ [field]: 1 }, { unique: true, sparse: true, name: legacy.name });
        throw createError;
      }
    } catch (error) {
      logger.error?.(`[index-migration] ${collectionName}.${field} failed: ${error.message}`);
    }
  }
};

module.exports = { ensureNullableUniqueIndexes, TARGETS };
