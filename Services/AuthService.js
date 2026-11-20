const { AuthRepository } = require("../Repositories/AuthRepository")
const { ReferralRepository } = require("../Repositories/ReferralRepository")
const { startSafeSession } = require("../Utilis/transactionRunner");
const bcrypt = require("bcrypt")
const crypto = require("crypto")
const genJWT = require("../Utilis/genJWT")
const genOTP = require("../Utilis/genOTP")
const sendEmail = require("../Utilis/sendEmail");
const verifyOtpTemplate = require("../Utilis/emailTemplates/verifyOtp");
const forgotPasswordTemplate = require("../Utilis/emailTemplates/forgotPassword");
const { MINIMUM_REGISTRATION_AGE, calculateAge, parseDobUtcMidnight } = require("../Utilis/ageValidation");

const AppError = require("../Utilis/AppError")
const { toSafeUserPayload } = require("../Utilis/userPayload")

/**
 * Mask an email for logs: "praisee827@gmail.com" -> "pr********@gmail.com".
 * Keeps recipient identifiable for support correlation without exposing PII
 * in full. Credential fields (OTP, password, API keys) are NEVER logged.
 */
const maskEmail = (email) =>
  String(email || "").replace(/^([^@]{1,2})[^@]*(@.*)$/, "$1********$2");

// Auth OTP brute-force hardening (mirrors PIN reset policy).
const AUTH_OTP_TTL_MS = 5 * 60 * 1000;
const AUTH_OTP_MAX_ATTEMPTS = Number(process.env.AUTH_OTP_MAX_ATTEMPTS) || 5;
const AUTH_OTP_LOCK_MS = Number(process.env.AUTH_OTP_LOCK_MS) || 15 * 60 * 1000;

const isOtpLocked = (attempts, lockedUntil) =>
  Number(attempts || 0) >= AUTH_OTP_MAX_ATTEMPTS && lockedUntil && new Date() < new Date(lockedUntil);

const recordOtpFailure = async (user, attemptsField, lockField) => {
  const attempts = Number(user[attemptsField] || 0) + 1;
  user[attemptsField] = attempts;
  user[lockField] = attempts >= AUTH_OTP_MAX_ATTEMPTS ? new Date(Date.now() + AUTH_OTP_LOCK_MS) : null;
  await user.save();
  return attempts;
};

// Helper function to generate unique referral code for new member
const generateUniqueReferralCode = () => {
  return "SM-" + crypto.randomBytes(3).toString("hex").toUpperCase();
};
const RegisterService = async(userData)=>{

        const {fullName, email, phone, referralCode, password, termsAccepted, privacyAccepted, dateOfBirth, gender, address, stateOfOrigin, occupation, monthlySavingsCommitment} = userData;
        
    // Terms & Conditions / Privacy Policy acceptance is mandatory at registration.
    if (termsAccepted !== true || privacyAccepted !== true) {
        throw new AppError("You must accept the Socket Monie Terms and Conditions and Privacy Policy to register.", 400);
    }

    // KYC age gate (server-side source of truth): applicants must be at least
    // 18 years old. Independently re-validated here so the rule cannot be
    // bypassed by omitting the client-side `max` attribute or client-side only
    // validation. dateOfBirth is mandatory (ISO 8601) via signUpSchema, and is
    // re-checked defensively here before any account is created.
    const dobUtcMidnight = parseDobUtcMidnight(dateOfBirth);
    if (dobUtcMidnight === null) {
        throw new AppError("A valid date of birth is required to create your account.", 400);
    }
    const nowUtcMidnight = Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate()
    );
    if (dobUtcMidnight > nowUtcMidnight) {
        throw new AppError("Date of birth cannot be in the future.", 400);
    }
    const age = calculateAge(dateOfBirth);
    if (age === null || age < MINIMUM_REGISTRATION_AGE) {
        throw new AppError("You must be at least 18 years old to create a SocketMonnie account.", 400);
    }

    // 1. Check for Duplicate Email and Phone
        const existingEmail = await AuthRepository.findByEntity("email", email);
        if (existingEmail) throw new AppError("Email already exists.", 409);
        
        const existingPhone = await AuthRepository.findByEntity("phone", phone);
        if (existingPhone) throw new AppError("Phone number already exists.", 409);

        // 2. Mandatory Referral Code Verification
        //cleanup referrercode
        const cleanedReferralCode = referralCode.trim().toUpperCase();

        const referrer = await AuthRepository.findByEntity("referralCode", cleanedReferralCode);
        if (!referrer) {
          throw new AppError("Invalid referral code. A valid member referral code is required to join SocketMonie.", 400);
        }
    
        // 3. Hash Password & Generate User's Own Unique Referral Code
        const hashedPassword = await bcrypt.hash(password, 13);
        const newMemberReferralCode = generateUniqueReferralCode();
        const otp = String(genOTP());

        const otpExpiresAt = new Date(Date.now() + AUTH_OTP_TTL_MS);

        const hashedOTP = await bcrypt.hash(otp, 12);

        const session = await startSafeSession();
        let newUser;
        try {
          await session.withTransaction(async () => {
            newUser = await AuthRepository.createUserIntoDB({
              fullName,
              email,
              phone,
              referralCode: newMemberReferralCode,
              referredBy: referrer._id,
              password: hashedPassword,
              otp: hashedOTP,
              otpExpiresAt,
              otpAttempts: 0,
              otpAttemptExpiresAt: null,
              isVerified: false,
              membershipFeePaid: false,
              status: "pending",
              termsAccepted: true,
              privacyAccepted: true,
              termsAcceptedAt: new Date(),
              privacyAcceptedAt: new Date(),
              termsVersion: process.env.TERMS_VERSION || "1.0",
              privacyVersion: process.env.PRIVACY_VERSION || "1.0",
              dateOfBirth: dobUtcMidnight ? new Date(dobUtcMidnight).toISOString() : null,
              gender: gender || null,
              address: address || null,
              stateOfOrigin: stateOfOrigin || null,
              occupation: occupation || null,
              monthlySavingsCommitment: monthlySavingsCommitment ?? 0,
            }, { session });

            await ReferralRepository.createRegistration({
              referrerId: referrer._id,
              referredUserId: newUser._id,
              referralCode: cleanedReferralCode,
              status: "registered",
              qualificationEvent: "none",
              referrerReward: 0,
              referredUserReward: 0,
              rewardStatus: "unearned",
            }, session);
          });
        } finally {
          await session.endSession();
        }
        
    
        // 5. Send Verification Email
        // Breadcrumbs identify exactly why OTP delivery fails while registration
        // + DB storage succeed. NEVER log the OTP itself, the password, or any
        // credential — only presence, recipient (masked), and vendor errors.
        console.log(
          `[auth][register] user stored (id=${newUser._id}, status=pending), OTP generated+hashed, attempting verification email...`
        );

        const emailResult = await sendEmail({
          to: newUser.email,
          subject: "Your SocketMonnie verification code",
          html: verifyOtpTemplate(newUser.fullName, otp),
        });

        if (!emailResult.success) {
          // Surface the ROOT CAUSE (e.g. "BREVO_API_KEY not configured", Brevo
          // auth/sender errors) — previously discarded, making the production
          // "registered but no OTP email" failure undiagnosable from logs.
          console.error(
            `[auth][register] ❌ OTP email delivery FAILED for user id=${newUser._id}: ${emailResult.error || "unknown vendor error"}`
          );
          const cause = emailResult.error ? ` (cause: ${emailResult.error})` : "";
          throw new AppError(`Account created but verification email could not be sent. Please check your inbox or spam/junk folder, or try resending the code.${cause}`, 502);
        }

        console.log(
          `[auth][register] ✅ OTP email delivered to ${maskEmail(newUser.email)} (messageId=${emailResult.messageId || "ok"})`
        );

        const responseData = { 
                userId: newUser._id, 
                email: newUser.email, 
                fullName: newUser.fullName, 
                isVerified: newUser.isVerified,
                membershipFeePaid: newUser.membershipFeePaid,
                avatarUrl: newUser.avatarUrl || newUser.selfieUrl || null,
              }
        return responseData
    
}



const LoginService = async({email, password})=>{
  let requiresVerification = false;
    const foundUser = await AuthRepository.findByEntity("email", email);
    if (!foundUser) throw new  AppError("Invalid email or password.", 400);
    
    const isPasswordCorrect = await bcrypt.compare(password, foundUser.password);
    if (!isPasswordCorrect) throw new  AppError("Invalid email or password.", 400);
    
    
    if (!foundUser.isVerified) {
      requiresVerification= true
      throw new AppError("Please verify your email before logging in.", 400);
    }
    if (foundUser.status === "suspended") {
      throw new AppError("Your account has been suspended. Please contact support.", 400);
    }
    // Terms & Conditions / Privacy Policy acceptance is mandatory before access.
    if (foundUser.termsAccepted !== true || foundUser.privacyAccepted !== true) {
      throw new AppError("Please accept the Socket Monie Terms and Conditions and Privacy Policy before accessing your account.", 403);
    }
    
    const user = toSafeUserPayload(foundUser);

    const token = genJWT(foundUser._id); 
    return { user, token , requiresVerification}
    
}

const VerifyOTPService = async({email, otp})=>{
    const foundUser = await AuthRepository.findByEntity("email", email);
    if (!foundUser) throw new AppError( "No account found with this email.", 400);
    if (foundUser.isVerified) throw new AppError("Your account has already been verified, please login", 409);
    if (isOtpLocked(foundUser.otpAttempts, foundUser.otpAttemptExpiresAt)) {
      throw new AppError("Too many invalid verification attempts. Please request a new code.", 429);
    }
    if (!foundUser.otp || !foundUser.otpExpiresAt) {
      throw new AppError("Verification code is invalid or has not been requested. Please request a new one.", 400);
    }
    if (new Date() > new Date(foundUser.otpExpiresAt)) {
      throw new AppError("OTP has expired. Please request a new one.", 400);
    }

    const isOtpValid = await bcrypt.compare(otp, foundUser.otp);
    if (!isOtpValid) {
      const attempts = await recordOtpFailure(foundUser, "otpAttempts", "otpAttemptExpiresAt");
      if (attempts >= AUTH_OTP_MAX_ATTEMPTS) {
        throw new AppError("Too many invalid verification attempts. Please request a new code.", 429);
      }
      throw new AppError("Invalid verification code.", 400);
    }

    await AuthRepository.updateVerifyOTPToMongo(email, foundUser.otp);
    const token =  genJWT(foundUser._id);

    // Re-read to return a safe, up-to-date payload after verification.
    const verifiedUser = await AuthRepository.findByEntity("email", email);
    const user = toSafeUserPayload(verifiedUser || foundUser);

    return { token, user, verified: true };
}

const ResendOTPService = async({ email }) => {
  const user = await AuthRepository.findByEntity("email", email);
  if (!user) throw new AppError("No account found with this email.", 400);
  if (user.isVerified) throw new AppError("Your account has already been verified. Please log in.", 409);

  const otp = String(genOTP());
  const expiresAt = new Date(Date.now() + AUTH_OTP_TTL_MS);
  const hashedOTP = await bcrypt.hash(otp, 12);

  const updated = await AuthRepository.updateResendVerificationOtp(email, hashedOTP, expiresAt);
  if (!updated) throw new AppError("Unable to resend verification code right now. Please try again.", 400);

  const emailResult = await sendEmail({
    to: updated.email,
    subject: "Your SocketMonnie verification code",
    html: verifyOtpTemplate(updated.fullName, otp),
  });

  if (!emailResult.success) {
    console.error(`[auth][resend-otp] ❌ OTP email delivery FAILED for ${maskEmail(updated.email)}: ${emailResult.error || "unknown vendor error"}`);
    // Clear unusable OTP so a fresh resend can be requested cleanly.
    try {
      updated.otp = null;
      updated.otpExpiresAt = null;
      updated.otpAttempts = 0;
      updated.otpAttemptExpiresAt = null;
      await updated.save();
    } catch (_) {
      /* best-effort cleanup */
    }
    const cause = emailResult.error ? ` (cause: ${emailResult.error})` : "";
    throw new AppError(`Verification code could not be sent. Please try again.${cause}`, 502);
  }

  console.log(`[auth][resend-otp] ✅ OTP email delivered to ${maskEmail(updated.email)} (messageId=${emailResult.messageId || "ok"})`);
  return {
    success: true,
    message: "A new verification code has been sent to your email. Please check your inbox or spam/junk folder if you don't see it.",
  };
}

const ForgotPasswordService = async({email})=>{
  const user = await AuthRepository.findByEntity("email", email);
    if (!user) throw new AppError( "No account found with that email.", 400);

    const otp = String(genOTP());
    const expiresAt = new Date(Date.now() + AUTH_OTP_TTL_MS);
    const resetPasswordOTP = await bcrypt.hash(otp, 12);
    const savedUser = await AuthRepository.savedUser( email, resetPasswordOTP, expiresAt )


    const emailResult = await sendEmail({
      to: savedUser.email,
      subject: "Reset Your Socket Moni Password",
      html: forgotPasswordTemplate(savedUser.fullName, otp),
    });
    if (!emailResult.success) {
      console.error("Email Error:", emailResult.error);
      // Clear unusable OTP so the user can request a fresh one cleanly.
      try {
        savedUser.resetPasswordOTP = null;
        savedUser.resetPasswordOTPExpiresAt = null;
        savedUser.resetPasswordAttempts = 0;
        savedUser.resetPasswordAttemptExpiresAt = null;
        await savedUser.save();
      } catch (_) {
        /* best-effort cleanup */
      }
      return {
        success: false,
        message: "Failed to send reset email. Please try again and check your inbox or spam/junk folder.",
        emailFailed: true,
      };
    }

    return {
      success:true,
      message: "Password reset OTP sent to your email. Please check your inbox or spam/junk folder if you don't see it.",
    }
}

const ResetPasswordService = async({ email, otp, newPassword }) => {
  const user = await AuthRepository.findByEntity("email", email);
  if (!user) throw new AppError("User not found.", 404);
  if (isOtpLocked(user.resetPasswordAttempts, user.resetPasswordAttemptExpiresAt)) {
    throw new AppError("Too many invalid OTP attempts. Please request a new reset code.", 429);
  }
  if (!user.resetPasswordOTP || !user.resetPasswordOTPExpiresAt) {
    throw new AppError("Password reset OTP is invalid or has expired. Please request a new code.", 400);
  }
  if (new Date() > new Date(user.resetPasswordOTPExpiresAt)) {
    throw new AppError("OTP has expired. Please request a new one and check your inbox or spam/junk folder.", 400);
  }

  const isValid = await bcrypt.compare(otp, user.resetPasswordOTP);
  if (!isValid) {
    const attempts = await recordOtpFailure(user, "resetPasswordAttempts", "resetPasswordAttemptExpiresAt");
    if (attempts >= AUTH_OTP_MAX_ATTEMPTS) {
      throw new AppError("Too many invalid OTP attempts. Please request a new reset code.", 429);
    }
    throw new AppError("Invalid OTP. Please check the code and try again, or request a new one.", 400);
  }

  const hashedPassword = await bcrypt.hash(newPassword, 13);
  const updatedUser = await AuthRepository.resetPassword(email, user.resetPasswordOTP, hashedPassword);
  if (!updatedUser) throw new AppError("User not found.", 404);
}

const AuthService ={
    RegisterService,
    LoginService,
    VerifyOTPService,
    ResendOTPService,
    ForgotPasswordService,
    ResetPasswordService
}

module.exports ={ AuthService }
