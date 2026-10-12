const { UserRepository } = require("../Repositories/UserRepository");
const bcrypt = require("bcrypt");
const AppError = require("../Utilis/AppError");
const genOTP = require("../Utilis/genOTP")
const sendEmail = require("../Utilis/sendEmail")
const { logAudit } = require("../Utilis/auditLogger")
const forgotPasswordTemplate = require("../Utilis/emailTemplates/forgotPassword"); 

const maskId = (value) => (value ? `********${String(value).slice(-4)}` : null);
const UserInfo = async(id)=>{
 
    const userData = await UserRepository.findUserDetails(id)
    if (!userData) return null


    userData.bvn = maskId(userData.bvn);
    userData.nin = maskId(userData.nin);

    return userData

}

const KYCUploadService = async (reqBody, file, reqUserID) => {
  if (!file?.path) throw new AppError('Uploaded document could not be stored', 400);

    const updateData = {
    documentType: reqBody.documentType,
    documentUrl: file.path,
    kycStatus: 'pending_review',
    kycUploadedAt: new Date(),
    };

  if (reqBody.bvn) updateData.bvn = reqBody.bvn;
  if (reqBody.nin) updateData.nin = reqBody.nin;
  const updatedUser = await UserRepository.UpdateDetails(reqUserID, updateData, { includeSensitive: true });
  if (!updatedUser) throw new AppError('User account not found', 404);

    return {
        documentType: updatedUser.documentType, 
        documentUrl: updatedUser.documentUrl, 
        kycStatus: updatedUser.kycStatus,
        bvn: updatedUser.bvn ? `********${String(updatedUser.bvn).slice(-4)}` : null,
        nin: updatedUser.nin ? `********${String(updatedUser.nin).slice(-4)}` : null
    }

}

const SetPinService = async (reqBody, reqUserID) => {
    const { pin } = reqBody;
    
    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(pin, salt);
    const updatedUser = await UserRepository.UpdateSetPin(reqUserID, hashedPin)
    if (!updatedUser) throw new AppError('User account not found', 404);
    return { isPinSet: updatedUser.isPinSet };
  
}

const BankDetailService = async (reqBody, reqUserID) => {
  const { bankName, bankCode, accountName, accountNumber } = reqBody;
  const updatedUser = await UserRepository.UpdateDetails(reqUserID, {
    bankDetails: {
      bankName,
      bankCode,
      accountName,
      accountNumber,
      verified: true,
      verifiedAt: new Date(),
    },
  });

  if (!updatedUser) throw new AppError("User not found", 404);

return {
    bankDetails:updatedUser.bankDetails,
    user: updatedUser
}

}


const ForgotPin = async (reqBody) => {
    const { email } = reqBody;
    const user = await UserRepository.findUserDetails(email)
  if (!user) throw new AppError("User not found.", 404);
    // Generate OTP
    const otp = String(genOTP());
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const pinResetOTP = await bcrypt.hash(otp, 12);
    const pinResetOTPExpiresAt = expiresAt;

    const updatedUser = await UserRepository.UpdateDetails(user._id, { pinResetOTP, pinResetOTPExpiresAt });
    if (!updatedUser) throw new AppError("User not found.", 404);

    // Send email
    const emailResult = await sendEmail({
      to: user.email,
      subject: "Reset Your Transaction PIN",
      html: forgotPasswordTemplate(user.fullName, otp), // Reuse template or create new one
    });
    if (!emailResult.success) {
      throw new AppError( "Failed to send reset email.", 400);
    }
}

const ResetPin = async (reqBody, reqUserID, auditContext = {}) => {
    const { email, otp, newPin } = reqBody;
    const user = await UserRepository.findUserDetails(email, { includeSensitive: true });

    if (!user) throw new AppError("User not found.", 404);
    if (String(user._id) !== String(reqUserID)) {
      throw new AppError("You can only reset the PIN for your own account.", 403);
    }
    if (!user.pinResetOTP || new Date() > user.pinResetOTPExpiresAt) {
      throw new AppError("OTP expired. Please request a new one.", 400);
    }
    const isValid = await bcrypt.compare(otp, user.pinResetOTP);
    if (!isValid) throw new AppError("Invalid OTP.", 400);
    // Hash new PIN
    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(newPin, salt);
    const transactionPin = hashedPin;
    const isPinSet = true;
    const pinResetOTP = null;
    const pinResetOTPExpiresAt = null;
    const updatedUser = await UserRepository.UpdateDetails(user._id, {
      transactionPin,
      isPinSet,
      pinResetOTP,
      pinResetOTPExpiresAt,
    });
    if (!updatedUser) throw new AppError("User account not found.", 404);
    // Audit log
    await logAudit({
      userId: user._id,
      userEmail: user.email,
      userRole: user.role,
      action: 'pin_reset',
      targetType: 'user',
      targetId: user._id,
      details: { resetType: 'forgot_pin' },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
    });
    
}


const UpdateProfile = async (reqBody, reqUserID) => {
    const user = await UserRepository.UpdateDetails(reqUserID, reqBody);
    if (!user) throw new AppError("User not found", 404);
    return { user };
}

const UpdatePersonalInfo = async (reqBody, reqUserID) => {
    const user = await UserRepository.UpdateDetails(reqUserID, reqBody);
    if (!user) throw new AppError("User not found", 404);
    return { user };
}

const UserService = {
    UserInfo, KYCUploadService, SetPinService, BankDetailService,
    ForgotPin, ResetPin, UpdateProfile, UpdatePersonalInfo
}

module.exports ={
    UserService, 
}