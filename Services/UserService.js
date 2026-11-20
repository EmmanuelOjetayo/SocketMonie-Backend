const { UserRepository } = require("../Repositories/UserRepository");
const bcrypt = require("bcrypt");
const AppError = require("../Utilis/AppError");
const genOTP = require("../Utilis/genOTP")
const sendEmail = require("../Utilis/sendEmail")
const { logAudit } = require("../Utilis/auditLogger")
const forgotPasswordTemplate = require("../Utilis/emailTemplates/forgotPassword"); 
const { cloudinary } = require("../Config/cloudinary");
const { isKycLocked, KYC_LOCKED_MESSAGE } = require("../Utilis/kycStatus");

const maskId = (value) => (value ? `********${String(value).slice(-4)}` : null);

// Transaction PIN recovery security policy (owner-approved):
// - OTP validity window for PIN reset requests.
// - Max failed OTP verification attempts before the member is locked out.
// - How long the failed-attempt lock persists.
const PIN_RESET_OTP_TTL_MS = 5 * 60 * 1000;
const PIN_RESET_MAX_ATTEMPTS = Number(process.env.PIN_RESET_MAX_ATTEMPTS) || 5;
const PIN_RESET_LOCK_MS = Number(process.env.PIN_RESET_LOCK_MS) || 15 * 60 * 1000;
const UserInfo = async(id)=>{
 
    const userData = await UserRepository.findUserDetails(id)
    if (!userData) return null


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
  // KYC approval lock (owner-approved decision): once an admin has approved
  // the member's KYC, the approved record is locked and can no longer be
  // modified or re-submitted by the member. Read-only access is retained.
  const existingUser = await UserRepository.findUserDetails(reqUserID, { includeSensitive: true });
  if (!existingUser) throw new AppError('User account not found', 404);
  if (isKycLocked(existingUser.kycStatus)) {
    throw new AppError(KYC_LOCKED_MESSAGE, 403);
  }

  if (!file?.path) throw new AppError('Uploaded document could not be stored', 400);

  // KYC policy: NIN is the sole national identity number collected.
  const nin = reqBody.nin ? String(reqBody.nin).trim() : null;
  if (!nin) throw new AppError('Your NIN is required to verify your identity.', 400);

  // No duplicate identity records across accounts.
  const duplicate = await UserRepository.findUserWithIdentityValue(reqUserID, { nin });
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

    // Security: always return the same generic outcome whether or not the
    // account exists, so the forgot-recovery endpoint cannot be used to
    // enumerate registered member emails.
    if (user) {
      const otp = String(genOTP());
      const expiresAt = new Date(Date.now() + PIN_RESET_OTP_TTL_MS);

      const pinResetOTP = await bcrypt.hash(otp, 12);
      const pinResetOTPExpiresAt = expiresAt;

      // Persist the hashed OTP + expiry BEFORE sending the email so a delivery
      // failure never leaves the member with an email they cannot use.
      const updatedUser = await UserRepository.UpdateDetails(user._id, {
        pinResetOTP,
        pinResetOTPExpiresAt,
        pinResetAttempts: 0,
        pinResetAttemptExpiresAt: null,
      });
      if (!updatedUser) throw new AppError("User not found.", 404);

      // Send email
      const emailResult = await sendEmail({
        to: user.email,
        subject: "Reset Your Transaction PIN",
        html: forgotPasswordTemplate(user.fullName, otp, "transaction PIN"), // Reuse template for the PIN reset flow
      });
      if (!emailResult.success) {
        // Delivery failed — clear the unusable OTP so the member can request
        // a fresh one without hitting a stale/invalid state.
        await UserRepository.UpdateDetails(user._id, {
          pinResetOTP: null,
          pinResetOTPExpiresAt: null,
        });
        throw new AppError("Failed to send reset email. Please try again.", 400);
      }
    }

    // Generic success — do not reveal account existence.
    return { success: true, message: "If an account exists for that email, a PIN reset OTP has been sent." };
}

const ResetPin = async (reqBody, reqUserID, auditContext = {}) => {
    const { email, otp, newPin } = reqBody;
    const user = await UserRepository.findUserDetails(email, { includeSensitive: true });

    if (!user) throw new AppError("User not found.", 404);
    if (String(user._id) !== String(reqUserID)) {
      throw new AppError("You can only reset the PIN for your own account.", 403);
    }
    // Distinguish "no/cleared OTP" from "expired" for a clear member-facing message.
    if (!user.pinResetOTP || !user.pinResetOTPExpiresAt) {
      throw new AppError("PIN reset OTP is invalid or has not been requested. Please request a new one.", 400);
    }
    if (new Date() > new Date(user.pinResetOTPExpiresAt)) {
      throw new AppError("OTP has expired. Please request a new one.", 400);
    }
    if ((user.pinResetAttempts || 0) >= PIN_RESET_MAX_ATTEMPTS) {
      throw new AppError("Too many invalid OTP attempts. Please request a new PIN reset.", 429);
    }
    const isValid = await bcrypt.compare(otp, user.pinResetOTP);
    if (!isValid) {
      // Brute-force guard: track failed verifications and lock the member out
      // briefly once the configured attempt threshold is exceeded.
      const attempts = (user.pinResetAttempts || 0) + 1;
      const updatedUser = await UserRepository.UpdateDetails(user._id, {
        pinResetAttempts: attempts,
        pinResetAttemptExpiresAt: attempts >= PIN_RESET_MAX_ATTEMPTS ? new Date(Date.now() + PIN_RESET_LOCK_MS) : null,
      });
      if (attempts >= PIN_RESET_MAX_ATTEMPTS) {
        throw new AppError("Too many invalid OTP attempts. Please request a new PIN reset.", 429);
      }
      throw new AppError("Invalid OTP.", 400);
    }

    // New PIN must never reuse the current (hashed) PIN.
    const pinRecord = await UserRepository.findUserByIdForPin(user._id);
    if (pinRecord?.transactionPin) {
      const isSamePin = await bcrypt.compare(newPin, pinRecord.transactionPin);
      if (isSamePin) throw new AppError("You must choose a new Transaction PIN different from your current PIN.", 400);
    }

    // Hash new PIN
    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(newPin, salt);
    const transactionPin = hashedPin;
    const isPinSet = true;
    const pinResetOTP = null;
    const pinResetOTPExpiresAt = null;
    const pinResetAttempts = 0;
    const pinResetAttemptExpiresAt = null;
    const updatedUser = await UserRepository.UpdateDetails(user._id, {
      transactionPin,
      isPinSet,
      pinResetOTP,
      pinResetOTPExpiresAt,
      pinResetAttempts,
      pinResetAttemptExpiresAt,
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
    
  };

// Change (rotate) an existing Transaction PIN. Requires the caller to be
// authenticated AND to know the current PIN; the backend re-validates the
// current PIN against the stored bcrypt hash (never trusting the client).
const ChangePinService = async (reqBody, reqUserID, auditContext = {}) => {
    const { currentPin, newPin, confirmNewPin } = reqBody;

    // Confirmation, when supplied, must match the new PIN.
    if (confirmNewPin !== undefined && confirmNewPin !== newPin) {
      throw new AppError("New PINs do not match.", 400);
    }

    const user = await UserRepository.findUserByIdForPin(reqUserID);
    if (!user) throw new AppError("User account not found", 404);
    if (!user.transactionPin) throw new AppError("Transaction PIN not set.", 400);

    const isCurrentPinValid = await bcrypt.compare(currentPin, user.transactionPin);
    if (!isCurrentPinValid) throw new AppError("Current Transaction PIN is incorrect.", 400);

    // A member cannot rotate to the same PIN they already have.
    const isSamePin = await bcrypt.compare(newPin, user.transactionPin);
    if (isSamePin) throw new AppError("New Transaction PIN must be different from your current PIN.", 400);

    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(newPin, salt);
    const transactionPin = hashedPin;
    const isPinSet = true;
    const pinResetOTP = null;
    const pinResetOTPExpiresAt = null;
    const pinResetAttempts = 0;
    const pinResetAttemptExpiresAt = null;

    const updatedUser = await UserRepository.UpdateDetails(reqUserID, {
      transactionPin,
      isPinSet,
      pinResetOTP,
      pinResetOTPExpiresAt,
      pinResetAttempts,
      pinResetAttemptExpiresAt,
    }, { includeSensitive: true });
    if (!updatedUser) throw new AppError("User account not found.", 404);

    // Invalidate any outstanding recovery authorization after a successful PIN change.
    const auditUser = await UserRepository.findUserDetails(reqUserID, { includeSensitive: true });
    await logAudit({
      userId: reqUserID,
      userEmail: auditUser?.email,
      userRole: auditUser?.role,
      action: 'pin_change',
      targetType: 'user',
      targetId: reqUserID,
      details: { changeType: 'transaction_pin' },
      ipAddress: auditContext.ipAddress,
      userAgent: auditContext.userAgent,
    });

    return { isPinSet: true };
}


const UpdateProfile = async (reqBody, reqUserID) => {
    // Defensive allowlist: this endpoint is not routed, but must never accept
    // privileged/sensitive fields (role, status, balances, PIN, OTP, etc.) if wired up.
    const ALLOWED_PROFILE_FIELDS = new Set([
      "fullName",
      "phone",
      "dateOfBirth",
      "gender",
      "address",
      "stateOfOrigin",
      "occupation",
      "monthlySavingsCommitment",
    ]);
    const safeUpdate = {};
    for (const [k, v] of Object.entries(reqBody || {})) {
      if (ALLOWED_PROFILE_FIELDS.has(k)) safeUpdate[k] = v;
    }
    if (Object.keys(safeUpdate).length === 0) {
      throw new AppError("No valid profile fields provided.", 400);
    }
    const user = await UserRepository.UpdateDetails(reqUserID, safeUpdate);
    if (!user) throw new AppError("User not found", 404);
    return { user };
}

const UpdatePersonalInfo = async (reqBody, reqUserID) => {
    const user = await UserRepository.findUserDetails(reqUserID);
    if (!user) throw new AppError("User not found", 404);

    // Defensive allowlist (middleware also validates/strips). Never permit
    // privilege escalation or financial/secret field mutation via this path.
    const ALLOWED_PERSONAL_FIELDS = new Set([
      "fullName",
      "phone",
      "dateOfBirth",
      "gender",
      "address",
      "stateOfOrigin",
      "occupation",
      "monthlySavingsCommitment",
    ]);
    const safeUpdate = {};
    for (const [k, v] of Object.entries(reqBody || {})) {
      if (ALLOWED_PERSONAL_FIELDS.has(k)) safeUpdate[k] = v;
    }

    // KYC approval lock (owner-approved decision): identity / residential
    // fields captured during onboarding become read-only once the member's
    // KYC has been approved. Attempts to change any of them are rejected with
    // 403 — the member may still view the submitted information.
    const LOCKED_IDENTITY_FIELDS = [
        "dateOfBirth",
        "gender",
        "address",
        "stateOfOrigin",
        "occupation",
    ];
    const attemptedLockedFields = LOCKED_IDENTITY_FIELDS.filter(
        (field) => safeUpdate[field] !== undefined
    );
    if (isKycLocked(user.kycStatus) && attemptedLockedFields.length > 0) {
        throw new AppError(KYC_LOCKED_MESSAGE, 403);
    }

    if (Object.keys(safeUpdate).length === 0) {
      throw new AppError("No valid personal information fields provided.", 400);
    }

    const updatedUser = await UserRepository.UpdateDetails(reqUserID, safeUpdate);
    if (!updatedUser) throw new AppError("User not found", 404);
    return { user: updatedUser };
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
    ForgotPin, ResetPin, ChangePinService, UpdateProfile, UpdatePersonalInfo, AcceptTermsService
}


module.exports ={
    UserService, 
}