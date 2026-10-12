const { AuthRepository } = require("../Repositories/AuthRepository")
const { ReferralRepository } = require("../Repositories/ReferralRepository")
const mongoose = require("mongoose")
const bcrypt = require("bcrypt")
const crypto = require("crypto")
const genJWT = require("../Utilis/genJWT")
const genOTP = require("../Utilis/genOTP")
const sendEmail = require("../Utilis/sendEmail");
const verifyOtpTemplate = require("../Utilis/emailTemplates/verifyOtp");
const forgotPasswordTemplate = require("../Utilis/emailTemplates/forgotPassword");

const AppError = require("../Utilis/AppError")
// Helper function to generate unique referral code for new member
const generateUniqueReferralCode = () => {
  return "SM-" + crypto.randomBytes(3).toString("hex").toUpperCase();
};
const RegisterService = async(userData)=>{

        const {fullName, email, phone, referralCode, password} = userData;
        
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

        const otpExpiresAt = new Date(
        Date.now() + 5 * 60 * 1000
        );

        const hashedOTP = await bcrypt.hash(otp, 12);

        const session = await mongoose.startSession();
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
              isVerified: false,
              membershipFeePaid: false,
              status: "pending"
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
        const emailResult = await sendEmail({
          to: newUser.email,
          subject: "Verify Your Socket Moni Account",
          html: verifyOtpTemplate(newUser.fullName, otp),
        });
    
        if (!emailResult.success) {
          throw new AppError("Account created but verification email could not be sent.", 502);
        }

        const responseData = { 
                userId: newUser._id, 
                email: newUser.email, 
                fullName: newUser.fullName, 
                isVerified: newUser.isVerified,
                membershipFeePaid: newUser.membershipFeePaid 
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
    
    const user = foundUser.toObject();
    delete user.password;
    delete user.otp;
    delete user.otpExpiresAt;
    delete user.resetPasswordOTP;
    delete user.resetPasswordOTPExpiresAt;

    const token = genJWT(foundUser._id); 
    return { user, token , requiresVerification}
    
}

const VerifyOTPService = async({email, otp})=>{
    const foundUser = await AuthRepository.findByEntity("email", email);
    if (!foundUser) throw new AppError( "No account found with this email.", 400);
    if (foundUser.isVerified) throw new AppError("Your account has already been verified, please login", 409);
    if (!foundUser.otp || !foundUser.otpExpiresAt || new Date() > foundUser.otpExpiresAt) {
      throw new AppError("OTP has expired. Please request a new one.", 400);
    }
    
    const isOtpValid = await bcrypt.compare(otp, foundUser.otp);
    if (!isOtpValid) throw new AppError("Invalid verification code.", 400);
  
    await AuthRepository.updateVerifyOTPToMongo(email, foundUser.otp);
    const token =  genJWT(foundUser._id);

    const user = foundUser.toObject();
    delete user.password;
    delete user.otp;
    delete user.otpExpiresAt;
    delete user.resetPasswordOTP;
    delete user.resetPasswordOTPExpiresAt;

    return { token, user, verified: true };
}


const ForgotPasswordService = async({email})=>{
  const user = await AuthRepository.findByEntity("email", email);
    if (!user) throw new AppError( "No account found with that email.", 400);
    
    const otp = String(genOTP());
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const resetPasswordOTP = await bcrypt.hash(otp, 12);
    const savedUser = await AuthRepository.savedUser( email, resetPasswordOTP, expiresAt )
    

    const emailResult = await sendEmail({
      to: savedUser.email,
      subject: "Reset Your Socket Moni Password",
      html: forgotPasswordTemplate(savedUser.fullName, otp),
    });
    if (!emailResult.success) {
      console.error("Email Error:", emailResult.error);
      throw new AppError("Failed to send reset email.", 500);
    }

    return {
      success:true
    }
}

const ResetPasswordService = async({ email, otp, newPassword }) => {
  const user = await AuthRepository.findByEntity("email", email);
  if (!user) throw new AppError("User not found.", 404);
  if (!user.resetPasswordOTP || !user.resetPasswordOTPExpiresAt) {
    throw new AppError("Password reset OTP is invalid or has expired.", 400);
  }
  if (new Date() > user.resetPasswordOTPExpiresAt) {
    throw new AppError("OTP has expired.", 400);
  }

  const isValid = await bcrypt.compare(otp, user.resetPasswordOTP);
  if (!isValid) throw new AppError("Invalid OTP.", 400);

  const hashedPassword = await bcrypt.hash(newPassword, 13);
  const updatedUser = await AuthRepository.resetPassword(email, user.resetPasswordOTP, hashedPassword);
  if (!updatedUser) throw new AppError("User not found.", 404);
}

const AuthService ={
    RegisterService,
    LoginService,
    VerifyOTPService,
    ForgotPasswordService,
    ResetPasswordService
}

module.exports ={ AuthService }