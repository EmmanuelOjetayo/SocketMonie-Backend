const dns = require("dns");

/**
 * Defensive DNS/connect helpers for MongoDB Atlas (mongodb+srv) and other URIs.
 *
 * Some environments (corporate/VPN/local resolvers, Windows flaky DNS) fail SRV
 * or A/AAAA lookups intermittently. We apply multiple defenses:
 *  - override resolvers with reliable public DNS servers (configurable)
 *  - prefer IPv4 results when the runtime supports it
 *  - use resilient mongoose connect options (timeouts, family)
 *  - retry connection attempts with backoff for transient DNS/network failures
 */

const DEFAULT_DNS_SERVERS = ["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1"];

function parseDnsServers(value) {
  if (!value) return DEFAULT_DNS_SERVERS.slice();
  const servers = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return servers.length ? servers : DEFAULT_DNS_SERVERS.slice();
}

let dnsConfigured = false;

function configureMongoDns() {
  if (dnsConfigured) return;
  dnsConfigured = true;

  try {
    const servers = parseDnsServers(process.env.MONGO_DNS_SERVERS || process.env.DNS_SERVERS);
    dns.setServers(servers);
  } catch (err) {
    // Never block startup/test runs because a resolver override failed; log and continue.
    console.warn("[mongo] DNS server override skipped:", err && err.message ? err.message : err);
  }

  try {
    if (typeof dns.setDefaultResultOrder === "function") {
      // Prefer IPv4 to avoid environments with broken IPv6 paths to Atlas.
      dns.setDefaultResultOrder("ipv4first");
    }
  } catch (err) {
    console.warn("[mongo] DNS result-order hint skipped:", err && err.message ? err.message : err);
  }
}

function getMongoUri() {
  return (
    process.env.MONGO_URL ||
    process.env.MONGODB_URI ||
    process.env.DATABASE_URL ||
    "mongodb://127.0.0.1:27017/socketmonnie"
  );
}

function getConnectOptions(overrides = {}) {
  const base = {
    // Atlas SRV/DNS issues often surface as long hangs; fail fast enough to retry.
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 15000,
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS) || 15000,
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 45000,
    // Prefer IPv4 in mixed/hostile network environments.
    family: 4,
  };
  return { ...base, ...overrides };
}

function isTransientConnectError(err) {
  const msg = String((err && (err.message || err.reason)) || err || "").toLowerCase();
  return (
    msg.includes("querysrv") ||
    msg.includes("eservfail") ||
    msg.includes("enotfound") ||
    msg.includes("eai_again") ||
    msg.includes("timed out") ||
    msg.includes("server selection") ||
    msg.includes("getaddrinfo") ||
    msg.includes("could not connect") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset")
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectMongooseWithRetry(mongoose, uri, options = {}, retryOptions = {}) {
  configureMongoDns();

  const attempts = Math.max(1, Number(retryOptions.attempts || process.env.MONGO_CONNECT_ATTEMPTS) || 5);
  const baseDelayMs = Math.max(250, Number(retryOptions.delayMs || process.env.MONGO_CONNECT_RETRY_DELAY_MS) || 1500);
  const connectOptions = getConnectOptions(options);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await mongoose.connect(uri, connectOptions);
      return mongoose.connection;
    } catch (err) {
      lastError = err;
      const transient = isTransientConnectError(err);
      const retryable = transient && attempt < attempts;
      const label = transient ? "transient" : "non-transient";
      console.error(
        `[mongo] connect attempt ${attempt}/${attempts} failed (${label}): ${err && err.message ? err.message : err}`
      );
      if (!retryable) break;
      const delay = Math.min(baseDelayMs * attempt, 10000);
      await sleep(delay);
    }
  }

  throw lastError;
}

module.exports = {
  configureMongoDns,
  getMongoUri,
  getConnectOptions,
  connectMongooseWithRetry,
  isTransientConnectError,
};
