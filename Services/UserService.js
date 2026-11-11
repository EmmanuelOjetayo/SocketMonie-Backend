const { UserRepository } = require("../Repositories/UserRepository");
const bcrypt = require("bcrypt");
const AppError = require("../Utilis/AppError");
const genOTP = require("../Utilis/genOTP")
const sendEmail = require("../Utilis/sendEmail")
const { logAudit } = require("../Utilis/auditLogger")
const forgotPasswordTemplate = require("../Utilis/emailTemplates/forgotPassword"); 
const { cloudinary } = require("../Config/cloudinary");

const maskId = (value) => (value ? `********${String(value).slice(-4)}` : null);
const UserInfo = async(id)=>{
 
    const userData = await UserRepository.findUserDetails(id)
    if (!userData) return null


    userData.bvn = maskId(userData.bvn);
    userData.nin = maskId(userData.nin);
    // Canonical API field for TopHeader/Profile — never expose Cloudinary secrets.
    userData.avatarUrl = userData.avatarUrl || userData.selfieUrl || null;
    userData.selfieUrl = userData.selfieUrl || userData.avatarUrl || null;

    return userData

}

/**
 * Profile-picture upload (single canonical path). Persists the Cloudinary
 * secure URL into `avatarUrl` (+ legacy `selfieUrl`) and the `public_id` so a
 * later replacement can delete the old asset. If DB persistence fails after a
 * successful upload, the newly uploaded asset is destroyed (no orphans).
 * Never logs the secure URL or credentials — only the public_id / presence.
 */
const UploadProfilePictureService = async (file, reqUserID) => {
  if (!file?.path) throw new AppError('Profile picture upload failed.', 400);
  const secureUrl = file.path;
  const publicId = file.public_id || null;

  const existing = await UserRepository.findUserDetails(reqUserID, { includeSensitive: true });
  const oldPublicId = existing?.profilePicturePublicId || null;

  let updatedUser;
  try {
    updatedUser = await UserRepository.UpdateDetails(reqUserID, {
      avatarUrl: secureUrl,
      selfieUrl: secureUrl,
      profilePicturePublicId: publicId,
    }, { includeSensitive: true });
  } catch (err) {
    // Orphan cleanup: delete the just-uploaded asset.
    try {
      if (publicId) await cloudinary.uploader.destroy(publicId);
    } catch (cleanupErr) {
      console.error("Profile picture orphan cleanup failed:", cleanupErr?.message || cleanupErr);
    }
    throw err;
  }

  if (!updatedUser) throw new AppError('User account not found', 404);

  // Replacement hygiene — best-effort delete of the previous asset.
  if (oldPublicId && publicId && oldPublicId !== publicId) {
    try {
      await cloudinary.uploader.destroy(oldPublicId);
    } catch (destroyErr) {
      console.error("Old profile picture cleanup failed:", destroyErr?.message || destroyErr);
    }
  }

  console.log(`[PROFILE PICTURE] avatar saved | userId: ${reqUserID} | secure_url stored: true | public_id: ${publicId || "—"}`);

  return {
    avatarUrl: updatedUser.avatarUrl,
    selfieUrl: updatedUser.selfieUrl,
    user: updatedUser,
  };
};

/**
 * Profile-picture deletion (CRUD "D"). Removes the stored Cloudinary asset
 * (best-effort — a destroyed/missing asset must still clear the account),
 * then clears avatarUrl/selfieUrl/profilePicturePublicId in one upate.
 * Re-deleting is idempotent: a no-op when no picture exists.
 */
const DeleteProfilePictureService = async (reqUserID) => {
  const existing = await UserRepository.findUserDetails(reqUserID, { includeSensitive: true });
  if (!existing) throw new AppError('User account not found', 404);

  const hadPicture = Boolean(existing.profilePicturePublicId || existing.avatarUrl || existing.selfieUrl);
  if (!hadPicture) {
    return { avatarUrl: null, selfieUrl: null, user: existing, alreadyDeleted: true };
  }

  const publicId = existing.profilePicturePublicId || null;
  const updatedUser = await UserRepository.UpdateDetails(reqUserID, {
    avatarUrl: null,
    selfieUrl: null,
    profilePicturePublicId: null,
  }, { includeSensitive: true });
  if (!updatedUser) throw new AppError('User account not found', 404);

  if (publicId) {
    try {
      await cloudinary.uploader.destroy(publicId);
    } catch (destroyErr) {
      // Asset already gone (404) or transient Cloudinary error — the account
      // is already cleared, so this is hygiene-only and must never fail the
      // API call. The Cloudinary folder can also be swept manually.
      console.error("Profile picture asset destroy failed:", destroyErr?.message || destroyErr);
    }
  }

  console.log(`[PROFILE PICTURE] avatar deleted | userId: ${reqUserID} | public_id: ${publicId || "—"}`);

  return {
    avatarUrl: null,
    selfieUrl: null,
    user: updatedUser,
    alreadyDeleted: false,
  };
};

const KYCUploadService = async (reqBody, file, reqUserID) => {
  if (!file?.path) throw new AppError('Uploaded document could not be stored', 400);

  // Owner-approved KYC policy: NIN is mandatory, BVN is optional.
  const nin = reqBody.nin ? String(reqBody.nin).trim() : null;
  const bvn = reqBody.bvn ? String(reqBody.bvn).trim() : null;
  if (!nin) throw new AppError('Your NIN is required to verify your identity.', 400);
  if (bvn && !/^\d{11}$/.test(bvn)) throw new AppError('BVN must be exactly 11 digits.', 400);

  // No duplicate identity records across accounts (owner-approved decision).
  const duplicate = await UserRepository.findUserWithIdentityValue(reqUserID, { nin, bvn });
  if (duplicate) {
    throw new AppError('This identity number is already linked to another member account.', 409);
  }

    const updateData = {
    documentType: reqBody.documentType,
    documentUrl: file.path,
    kycStatus: 'pending_review',
    kycRejectionReason: null, // re-uploads re-enter the admin verification queue cleanly
    kycUploadedAt: new Date(),
    };

  if (nin) updateData.nin = nin;
  if (bvn) updateData.bvn = bvn;
  let updatedUser;
  try {
    updatedUser = await UserRepository.UpdateDetails(reqUserID, updateData, { includeSensitive: true });
  } catch (err) {
    // Orphan cleanup (KYC deep lifecycle): if DB persistence fails after a
    // successful upload, delete the newly uploaded asset so no orphan remains.
    try {
      if (file?.public_id) {
        await cloudinary.uploader.destroy(file.public_id);
      }
    } catch (cleanupErr) {
      console.error("KYC orphan cleanup failed:", cleanupErr?.message || cleanupErr);
    }
    throw err;
  }
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
  console.log(
    `[BANK] saving bank details | userId: ${reqUserID} | bankName: ${bankName || "—"} | bankCode: ${bankCode || "—"} | accountName: ${accountName || "—"} | accountNumber: ${accountNumber ? `present(len=${String(accountNumber).length})` : "missing"}`
  );
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

  console.log(`[BANK] bank details saved | userId: ${reqUserID} | verified: ${updatedUser?.bankDetails?.verified}`);

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

// Terms & Conditions / Privacy Policy acceptance capture (for members whose
// stored flags predate enforcement, e.g. accounts created before Batch F).
const AcceptTermsService = async (reqUserID, termsAccepted, privacyAccepted) => {
    if (termsAccepted !== true || privacyAccepted !== true) {
        throw new AppError("Terms and Conditions acceptance is required.", 400);
    }
    const user = await UserRepository.UpdateDetails(
        reqUserID,
        {
            termsAccepted: true,
            privacyAccepted: true,
            termsAcceptedAt: new Date(),
            privacyAcceptedAt: new Date(),
            termsVersion: process.env.TERMS_VERSION || "1.0",
            privacyVersion: process.env.PRIVACY_VERSION || "1.0",
        },
        { includeSensitive: true }
    );
    if (!user) throw new AppError("User not found", 404);
    return { user };
}

const UserService = {
    UserInfo, KYCUploadService, SetPinService, BankDetailService,
    UploadProfilePictureService,
    DeleteProfilePictureService,
    ForgotPin, ResetPin, UpdateProfile, UpdatePersonalInfo, AcceptTermsService
}


module.exports ={
    UserService, 
}