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
        select: options.includeSensitive ? privateFields : `${privateFields} -bvn -nin`,
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


const UserRepository ={
    findUserDetails,
    UpdateDetails,
    UpdateSetPin
}
module.exports={
    UserRepository
}