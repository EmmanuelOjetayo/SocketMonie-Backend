const joi = require("joi");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const Users = require("../Models/UserModel");
const genJWT = require("../Utilis/genJWT.js");
const genOTP = require("../Utilis/genOTP.js");
const sendEmail = require("../Utilis/sendEmail");
const verifyOtpTemplate = require("../Utilis/emailTemplates/verifyOtp");
const forgotPasswordTemplate = require("../Utilis/emailTemplates/forgotPassword");

// Helper function to generate unique referral code for new member
const generateUniqueReferralCode = () => {
  return "SM-" + crypto.randomBytes(3).toString("hex").toUpperCase();
};

const loginSchema = joi.object({
  email: joi.string().trim().email().lowercase().required(),
  password: joi.string().required(),
});

const Login = async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      const errors = {};
      error.details.forEach((err) => { errors[err.path[0]] = err.message; });
      return res.status(400).json({ success: false, message: "Validation failed.", errors });
    }
    const { email, password } = value;
    const foundUser = await Users.findOne({ email });
    if (!foundUser) return res.status(401).json({ success: false, message: "Invalid email or password." });
    
    const isPasswordCorrect = await bcrypt.compare(password, foundUser.password);
    if (!isPasswordCorrect) return res.status(401).json({ success: false, message: "Invalid email or password." });
    
    if (!foundUser.isVerified) {
      return res.status(403).json({ success: false, message: "Please verify your email before logging in.", requiresVerification: true });
    }
    if (foundUser.status === "suspended") {
      return res.status(403).json({ success: false, message: "Your account has been suspended. Please contact support." });
    }
    
    const user = foundUser.toObject();
    delete user.password;
    delete user.otp;
    delete user.resetPasswordOTP;

    const token = await genJWT(foundUser._id);
    return res.status(200).json({ 
      success: true, 
      message: "Login successful.", 
      data: { token, user } 
    });
  } catch (error) { next(error); }
};

const signUpSchema = joi.object({
  fullName: joi.string().trim().min(3).max(100).required(),
  email: joi.string().trim().email().lowercase().required(),
  phone: joi.string().trim().pattern(/^\d{11}$/).required(),
  referralCode: joi.string().trim().uppercase().required(), // Code of referring member
  password: joi.string().min(8).max(30).required(),
});

const Register = async (req, res, next) => {
  try {
    const { error, value } = signUpSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      const errors = {};
      error.details.forEach((err) => { errors[err.path[0]] = err.message; });
      return res.status(400).json({ success: false, message: "Validation failed.", errors });
    }
    const { fullName, email, phone, password, referralCode } = value;

    // 1. Check for Duplicate Email and Phone
    const existingEmail = await Users.findOne({ email });
    if (existingEmail) return res.status(409).json({ success: false, message: "Email already exists." });
    
    const existingPhone = await Users.findOne({ phone });
    if (existingPhone) return res.status(409).json({ success: false, message: "Phone number already exists." });

    // 2. PRD Section 4: Mandatory Referral Code Verification
    const referrer = await Users.findOne({ referralCode: referralCode.trim().toUpperCase() });
    if (!referrer) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid referral code. A valid member referral code is required to join SocketMonie." 
      });
    }

    // 3. Hash Password & Generate User's Own Unique Referral Code
    const hashedPassword = await bcrypt.hash(password, 13);
    const newMemberReferralCode = generateUniqueReferralCode();

    const user = await Users.create({
      fullName, 
      email, 
      phone, 
      referralCode: newMemberReferralCode, // User's own unique referral code
      referredBy: referrer._id,            // Link to referring member
      password: hashedPassword, 
      isVerified: false, 
      membershipFeePaid: false,            // Defaults to unpaid paywall
      status: "pending"
    });

    // 4. Generate OTP
    const otp = String(genOTP());
    const otpExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
    user.otp = await bcrypt.hash(otp, 12);
    user.otpExpiresAt = otpExpiresAt;
    await user.save();

    // 5. Send Verification Email
    const emailResult = await sendEmail({
      to: user.email,
      subject: "Verify Your Socket Moni Account",
      html: verifyOtpTemplate(user.fullName, otp),
    });

    if (!emailResult.success) {
      console.error("Email Error:", emailResult.error);
      return res.status(500).json({
        success: false,
        message: "Account created but verification email could not be sent.",
        error: emailResult.message,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Account created successfully. Please verify your email.",
      data: { 
        userId: user._id, 
        email: user.email, 
        fullName: user.fullName, 
        isVerified: user.isVerified,
        membershipFeePaid: user.membershipFeePaid 
      },
    });
  } catch (error) { next(error); }
};

const verifyOtpSchema = joi.object({ 
  email: joi.string().email().required(), 
  otp: joi.string().length(4).required() 
});

const VerifyOtp = async (req, res, next) => {
  try {
    const { error, value } = verifyOtpSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      const errors = {};
      error.details.forEach((err) => { errors[err.path[0]] = err.message; });
      return res.status(400).json({ success: false, message: "Validation failed.", errors });
    }
    const { email, otp } = value;
    const foundUser = await Users.findOne({ email });
    if (!foundUser) return res.status(404).json({ success: false, message: "No account found with this email." });
    if (foundUser.isVerified) return res.status(400).json({ success: false, message: "Your account has already been verified, please login" });
    if (new Date() > foundUser.otpExpiresAt) return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
    
    const isOtpValid = await bcrypt.compare(otp, foundUser.otp);
    if (!isOtpValid) return res.status(400).json({ success: false, message: "Invalid verification code." });
    
    foundUser.isVerified = true;
    foundUser.otp = null;
    foundUser.otpExpiresAt = null;
    await foundUser.save();

    const token = await genJWT(foundUser._id);
    return res.status(200).json({
      success: true,
      message: "Account verified successfully.",
      data: {
        verified: true,
        token,
        user: { 
          _id: foundUser._id, 
          fullName: foundUser.fullName, 
          email: foundUser.email, 
          phone: foundUser.phone, 
          role: foundUser.role, 
          isVerified: foundUser.isVerified,
          membershipFeePaid: foundUser.membershipFeePaid,
          referralCode: foundUser.referralCode
        }
      },
    });
  } catch (error) { next(error); }
};

const forgotPasswordSchema = joi.object({ email: joi.string().email().required() });
const ForgotPassword = async (req, res, next) => {
  try {
    const { error, value } = forgotPasswordSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });
    const { email } = value;
    const user = await Users.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: "No account found with that email." });
    
    const otp = String(genOTP());
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    user.resetPasswordOTP = await bcrypt.hash(otp, 12);
    user.resetPasswordOTPExpiresAt = expiresAt;
    await user.save();

    const emailResult = await sendEmail({
      to: user.email,
      subject: "Reset Your Socket Moni Password",
      html: forgotPasswordTemplate(user.fullName, otp),
    });
    if (!emailResult.success) {
      console.error("Email Error:", emailResult.error);
      return res.status(500).json({ success: false, message: "Failed to send reset email." });
    }
    return res.status(200).json({ success: true, message: "Password reset OTP sent to your email." });
  } catch (error) { next(error); }
};

const resetPasswordSchema = joi.object({
  email: joi.string().email().required(),
  otp: joi.string().length(4).required(),
  newPassword: joi.string().min(8).required(),
});

const ResetPassword = async (req, res, next) => {
  try {
    const { error, value } = resetPasswordSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });
    const { email, otp, newPassword } = value;
    const user = await Users.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    if (new Date() > user.resetPasswordOTPExpiresAt) return res.status(400).json({ success: false, message: "OTP has expired." });
    
    const isValid = await bcrypt.compare(otp, user.resetPasswordOTP);
    if (!isValid) return res.status(400).json({ success: false, message: "Invalid OTP." });
    
    const hashedPassword = await bcrypt.hash(newPassword, 13);
    user.password = hashedPassword;
    user.resetPasswordOTP = null;
    user.resetPasswordOTPExpiresAt = null;
    await user.save();
    return res.status(200).json({ success: true, message: "Password reset successful. Please log in." });
  } catch (error) { next(error); }
};

module.exports = { Login, Register, VerifyOtp, ForgotPassword, ResetPassword };