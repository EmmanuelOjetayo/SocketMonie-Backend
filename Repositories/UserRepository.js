const mongoose = require("mongoose");
const Users = require("../Models/UserModel");

const privateFields = "-password -transactionPin -pinResetOTP -pinResetOTPExpiresAt";

const findUserDetails = async (entity, options = {}) => {
    const query = mongoose.isValidObjectId(entity)
        ? { _id: entity }
        : { email: String(entity).trim().toLowerCase() };

    const projection = options.includeSensitive
        ? "-password -transactionPin"
        : privateFields;

    const response = await Users.findOne(query)
        .select(projection)
        .session(options.session || null)
        .lean();

    return response;
}

const UpdateDetails = async (reqUserId, UpdateData, options = {}) => {
    const response = await Users.findByIdAndUpdate(reqUserId, UpdateData, {
        new: true,
        runValidators: true,
        select: options.includeSensitive ? privateFields : `${privateFields} -nin`,
        session: options.session,
    });
    return response;
}


const UpdateSetPin = async (reqUserID, hashedPin, options = {}) => {
    const response = await Users.findByIdAndUpdate(
        reqUserID,
        { transactionPin: hashedPin, isPinSet: true },
        { returnDocument: 'after', runValidators: true, session: options.session }
    );
    return response
}

// Transaction PIN security flows (change / reset) need the bcrypt hash to
// verify a submitted PIN. This lookup is INTERNAL-ONLY: it projects just the
// hash (plus _id) so no other sensitive field can leak, and it must never be
// used for response payloads.
const findUserByIdForPin = async (userId) => {
    const response = await Users.findById(userId)
        .select("transactionPin")
        .lean();
    return response;
};

// Duplicate identity prevention: an NIN may be linked to only one member account.
const findUserWithIdentityValue = async (excludeUserId, { nin }) => {
    const identities = [];
    if (nin) identities.push({ nin: String(nin).trim() });
    if (!identities.length) return null;

    return await Users.findOne({
        _id: { $ne: excludeUserId },
        $or: identities,
    })
        .select("_id fullName")
        .lean();
}


const UserRepository ={
    findUserDetails,
    UpdateDetails,
    UpdateSetPin,
    findUserByIdForPin,
    findUserWithIdentityValue
}
module.exports={
    UserRepository
}