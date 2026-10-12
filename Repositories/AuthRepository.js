
const Users = require("../Models/UserModel");
const AppError = require("../Utilis/AppError");

const findByEntity = async (field, value) => {
    const allowedFields = ["email", "phone", "referralCode"];
    if (!allowedFields.includes(field)) {
        throw new AppError("Invalid authentication lookup.", 400);
    }

    if (!field || value === undefined || value === null) {
        throw new AppError("Invalid authentication lookup.", 400);
    }

    const normalizedValue = typeof value === "string"
        ? field === "email"
            ? value.trim().toLowerCase()
            : field === "referralCode"
                ? value.trim().toUpperCase()
                : value.trim()
        : value;
  return await Users.findOne({ [field]: normalizedValue });
};

const createUserIntoDB = async (userData, options = {})=>{
    try {
        if (options.session) {
            const [user] = await Users.create([userData], { session: options.session });
            return user;
        }
        return await Users.create(userData);
    } catch (error) {
        if (error.code === 11000) {
            const duplicateField = Object.keys(error.keyPattern || {})[0] || "field";
            const fieldLabels = { email: "Email", phone: "Phone number", referralCode: "Referral code" };
            throw new AppError(`${fieldLabels[duplicateField] || duplicateField} already exists.`, 409);
        }
        throw error;
    }
}

const updateVerifyOTPToMongo = async (email, expectedOtp) => {
    const response = await Users.findOneAndUpdate(
        {
            email: email.trim().toLowerCase(),
            isVerified: false,
            otp: expectedOtp,
        },
        {
            isVerified: true,
            otp: null,
            otpExpiresAt: null,
        },
        { new: true, runValidators: true }
    );

    if (!response) throw new AppError("Verification code is invalid or has already been used.", 409);
    return response;
}

async function savedUser( email, resetPasswordOTP, expiresAt ){
    const user = await Users.findOne({ email: email.trim().toLowerCase() });
    if (!user) throw new AppError("No account found with that email.", 404);
    user.resetPasswordOTP = resetPasswordOTP;
    user.resetPasswordOTPExpiresAt = expiresAt;
    await user.save()
    return user;
}

async function resetPassword(email, expectedOtp, hashedPassword) {
    return await Users.findOneAndUpdate(
        {
            email: email.trim().toLowerCase(),
            resetPasswordOTP: expectedOtp,
        },
        {
            password: hashedPassword,
            resetPasswordOTP: null,
            resetPasswordOTPExpiresAt: null,
        },
        { new: true, runValidators: true }
    );
}

const AuthRepository = {
    findByEntity,
    createUserIntoDB,
    updateVerifyOTPToMongo,
    savedUser,
    resetPassword
    
}

module.exports ={
    AuthRepository
}