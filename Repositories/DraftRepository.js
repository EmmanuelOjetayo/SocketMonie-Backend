const UserDraft = require("../Models/UserDraftModel");

const findDraft = async (userId, kind) => {
    if (kind) {
        return await UserDraft.findOne({ userId, kind }).lean();
    }
    return await UserDraft.findOne({ userId }).lean();
};

const upsertDraft = async (userId, kind, data) => {
    return await UserDraft.findOneAndUpdate(
        { userId },
        { userId, kind, data },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();
};

const deleteDraft = async (userId) => {
    return await UserDraft.deleteOne({ userId });
};

module.exports = {
    DraftRepository: { findDraft, upsertDraft, deleteDraft },
};
