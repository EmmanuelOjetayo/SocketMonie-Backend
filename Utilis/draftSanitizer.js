/**
 * Pure draft-payload utilities (owner decision #4). Deliberately mongoose-free
 * so they can be unit-tested without a database connection.
 */

const DRAFT_INACTIVITY_DAYS = 30;
const MAX_DRAFT_BYTES = 50 * 1024; // 50KB — drafts are small state, not backups

// Flat + shallow-recursive sensitive-key filter. Drafts are plain UI state
// (values, step, statuses); anything secret-shaped is stripped defensively.
const SENSITIVE_KEY = /pass(word)?|otp|pin|token|secret|cvv|auth|credential/i;

const sanitizeDraftData = (input, depth = 0) => {
  if (depth > 3) return undefined; // draft state is never this deep
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeDraftData(item, depth + 1)).filter((item) => item !== undefined);
  }
  if (input === null || typeof input !== "object") {
    return input;
  }
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(String(key))) continue;
    const sanitized = sanitizeDraftData(value, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
};

const validateDraftPayload = (data) => {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Draft data must be an object.");
  }
  try {
    if (JSON.stringify(data).length > MAX_DRAFT_BYTES) {
      throw new Error("Draft data is too large to save.");
    }
  } catch (err) {
    if (err.message === "Draft data is too large to save.") throw err;
    throw new Error("Draft data must be JSON-serializable.");
  }
};

const expiresAtFor = (updatedAt) =>
  new Date(updatedAt).getTime() + DRAFT_INACTIVITY_DAYS * 24 * 60 * 60 * 1000;

module.exports = {
  DRAFT_INACTIVITY_DAYS,
  MAX_DRAFT_BYTES,
  SENSITIVE_KEY,
  sanitizeDraftData,
  validateDraftPayload,
  expiresAtFor,
};
