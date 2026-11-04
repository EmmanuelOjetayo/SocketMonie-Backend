const AppError = require("../Utilis/AppError");
const { DraftRepository } = require("../Repositories/DraftRepository");
const {
  sanitizeDraftData,
  validateDraftPayload,
  expiresAtFor,
  DRAFT_INACTIVITY_DAYS,
} = require("../Utilis/draftSanitizer");

/**
 * Server-side draft persistence (owner-approved decision #4):
 * - User-scoped, authenticated; backend is the source of truth.
 * - Resume across sessions and devices.
 * - Incomplete drafts expire after 30 days of inactivity.
 * - NEVER persist passwords, OTPs, PINs, tokens or other secrets.
 *     (pure helpers live in Utilis/draftSanitizer.js — mongoose-free)
 */

const GetUserDraftService = async (userId, kind) => {
  const draft = await DraftRepository.findDraft(userId, kind);
  if (!draft) return null;

  // 30-day inactivity expiry — evaluated on read (cheap, no cron needed).
  if (expiresAtFor(draft.updatedAt) < Date.now()) {
    await DraftRepository.deleteDraft(userId);
    return null;
  }

  return {
    kind: draft.kind,
    data: draft.data,
    updatedAt: draft.updatedAt,
  };
};

const SaveUserDraftService = async (userId, kind, data) => {
  try {
    validateDraftPayload(data);
  } catch (err) {
    throw new AppError(err.message.includes("too large") ? err.message : "Draft data must be a JSON-serializable object.", err.message.includes("too large") ? 413 : 400);
  }
  const sanitized = sanitizeDraftData(data);
  const draft = await DraftRepository.upsertDraft(userId, kind, sanitized);
  return {
    kind: draft.kind,
    data: draft.data,
    updatedAt: draft.updatedAt,
  };
};

const DeleteUserDraftService = async (userId) => {
  await DraftRepository.deleteDraft(userId);
  return true;
};

module.exports = {
  DraftService: { GetUserDraftService, SaveUserDraftService, DeleteUserDraftService, sanitizeDraftData },
};
