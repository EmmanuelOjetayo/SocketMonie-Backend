const mongoose = require("mongoose");

/**
 * Transaction support detection.
 *
 * Multi-document transactions require a replica set (or a sharded cluster).
 * On a standalone MongoDB — a single-node deployment, a local dev box, some
 * managed offerings — the server rejects the first transaction command with
 * "Transaction numbers are only allowed on a replica set member or mongos".
 * That error surfaced as a 500 from the Flutterwave webhook handler and as a
 * 500 from admin approval, i.e. exactly the money paths that must not fail.
 *
 * The capability is probed once and cached. When transactions are
 * unavailable, sessions still work (they scope the queries) but they are not
 * atomic: the work unit runs as a plain sequence of writes.
 *
 * Why this is safe to degrade:
 *   - every settlement path in this codebase is already idempotent BY
 *     REFERENCE (guarded by status filters / reference lookups), so a partial
 *     write can be safely replayed;
 *   - on production (MongoDB Atlas) the deployment IS a replica set, so the
 *     atomic path is the one that actually runs.
 */

let transactionsSupported = null;

const detectTransactionSupport = async () => {
  if (transactionsSupported !== null) return transactionsSupported;

  try {
    const probe = await mongoose.startSession();
    try {
      await probe.withTransaction(async (txnSession) => {
        // A transaction only becomes real once a READ is issued inside it:
        // the driver then sends a transaction number, which a standalone
        // server rejects with "Transaction numbers are only allowed on a
        // replica set member or mongos". An empty callback (or a ping) issues
        // no transactional command and would falsely report support.
        // A dedicated probe collection keeps this away from app data.
        await mongoose.connection.db
          .collection("__transaction_support_probe__")
          .findOne({}, { session: txnSession });
      });
      transactionsSupported = true;
    } catch (_) {
      transactionsSupported = false;
    } finally {
      await probe.endSession();
    }
  } catch (_) {
    transactionsSupported = false;
  }

  return transactionsSupported;
};

/**
 * Starts a Mongo session whose `withTransaction()` works on deployments
 * without transaction support: the callback is executed directly instead of
 * throwing, so callers keep their atomic code path on replica sets and still
 * make progress on standalone servers.
 */
const startSafeSession = async () => {
  const session = await mongoose.startSession();
  const supported = await detectTransactionSupport();

  if (!supported) {
    session.withTransaction = async (fn) => fn(session);
    session.transactionFallback = true;
  }

  return session;
};

/** Test/ops helper: forget the cached capability (e.g. after a topology change). */
const resetTransactionSupportCache = () => {
  transactionsSupported = null;
};

module.exports = {
  startSafeSession,
  detectTransactionSupport,
  resetTransactionSupportCache,
};
