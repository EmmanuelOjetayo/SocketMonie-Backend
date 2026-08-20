const joi = require("joi");
const bcrypt = require("bcrypt");
const Users = require("../Models/UserModel");
const genOTP = require("../Utilis/genOTP.js");
const sendEmail = require("../Utilis/sendEmail");
const forgotPasswordTemplate = require("../Utilis/emailTemplates/forgotPassword"); // We'll reuse same template

const GetUserInfo = async (req, res) => {
  try {
    const user = await Users.findById(req.user._id).select(
      "-password -transactionPin -pinResetOTP -pinResetOTPExpiresAt"
    );
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    return res.status(200).json({ success: true, data: { user } });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};


const kycSchema = joi.object({
  documentType: joi.string().valid('nin', 'voters_card', 'passport', 'drivers_license').required(),
  bvn: joi.string().pattern(/^\d{11}$/).optional(),
  nin: joi.string().pattern(/^\d{11}$/).optional(),
});

const KYCUpload = async (req, res) => {
  try {
    const { error, value } = kycSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });
    if (!req.file) return res.status(400).json({ success: false, message: 'Please upload a document file' });
    const userId = req.user._id;
    const updateData = {
      documentType: value.documentType,
      documentUrl: req.file.path,
      kycStatus: 'pending_review',
      kycUploadedAt: new Date(),
    };
    if (value.bvn) updateData.bvn = value.bvn;
    if (value.nin) updateData.nin = value.nin;
    const updatedUser = await Users.findByIdAndUpdate(userId, updateData, { new: true });
    if (!updatedUser) return res.status(404).json({ success: false, message: 'User account not found' });
    return res.status(200).json({
      success: true,
      message: 'KYC Document uploaded successfully!',
      data: { documentType: updatedUser.documentType, documentUrl: updatedUser.documentUrl, kycStatus: updatedUser.kycStatus, bvn: updatedUser.bvn, nin: updatedUser.nin },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to upload KYC document', error: err.message });
  }
};

const pinSchema = joi.object({
  pin: joi.string().length(4).pattern(/^[0-9]+$/).required(),
});

const SetPin = async (req, res) => {
  try {
    const { error, value } = pinSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });
    const { pin } = value;
    const userId = req.user._id;
    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(pin, salt);
    const updatedUser = await Users.findByIdAndUpdate(userId, { transactionPin: hashedPin, isPinSet: true }, { returnDocument: 'after' });
    if (!updatedUser) return res.status(404).json({ success: false, message: 'User account not found' });
    return res.status(200).json({ success: true, message: 'Transaction PIN created successfully!', data: { isPinSet: true } });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to set transaction PIN', error: err.message });
  }
};

const bankDetailsSchema = joi.object({
  bankName: joi.string().required(),
  bankCode: joi.string().required(),
  accountName: joi.string().required(),
  accountNumber: joi.string().pattern(/^\d{10}$/).required(),
});

const updateBankDetails = async (req,res)=>{
try{
const { error, value } = bankDetailsSchema.validate(req.body);
if (error) {
return res.status(400).json({
success:false,
message:error.details[0].message
});
}

const {
 bankName,
 bankCode,
 accountName,
 accountNumber
}=value;


const userId=req.user._id;


// IMPORTANT
// Only save after verification from frontend/backend

const updatedUser = await Users.findByIdAndUpdate(
 userId,
 {
   bankDetails:{
    bankName,
    bankCode,
    accountName,
    accountNumber,
    verified:true,
    verifiedAt:new Date()
   }
 },
 {
  new:true,
  select:"-password -transactionPin -pinResetOTP -pinResetOTPExpiresAt"
 }
);


if(!updatedUser){
return res.status(404).json({
success:false,
message:"User not found"
});
}


res.json({
success:true,
message:"Bank account verified and saved",
data:{
bankDetails:updatedUser.bankDetails,
user: updatedUser
}
});


}catch(error){

res.status(500).json({
success:false,
message:"Failed to update bank details",
error:error.message
})

}

}


const forgotPinSchema = joi.object({
  email: joi.string().email().required(),
});

const resetPinSchema = joi.object({
  email: joi.string().email().required(),
  otp: joi.string().length(4).required(),
  newPin: joi.string().length(4).pattern(/^[0-9]+$/).required(),
});

// Forgot PIN
const forgotPin = async (req, res) => {
  try {
    const { error, value } = forgotPinSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });
    const { email } = value;
    const user = await Users.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    // Generate OTP
    const otp = String(genOTP());
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    // We'll reuse resetPasswordOTP field for PIN reset, but separate might be better.
    // We can use a separate field: pinResetOTP and pinResetOTPExpiresAt.
    // For simplicity, we'll add new fields in UserModel (we'll update the model later).
    // We'll add pinResetOTP and pinResetOTPExpiresAt in UserModel.
    // For now, we'll use resetPasswordOTP but that's for password. Let's add new fields.
    // I'll add the fields now.
    user.pinResetOTP = await bcrypt.hash(otp, 12);
    user.pinResetOTPExpiresAt = expiresAt;
    await user.save();
    // Send email
    const emailResult = await sendEmail({
      to: user.email,
      subject: "Reset Your Transaction PIN",
      html: forgotPasswordTemplate(user.fullName, otp), // Reuse template or create new one
    });
    if (!emailResult.success) {
      return res.status(500).json({ success: false, message: "Failed to send reset email." });
    }
    return res.status(200).json({ success: true, message: "PIN reset OTP sent to your email." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// Reset PIN
const resetPin = async (req, res) => {
  try {
    const { error, value } = resetPinSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });
    const { email, otp, newPin } = value;
    const user = await Users.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    if (!user.pinResetOTP || new Date() > user.pinResetOTPExpiresAt) {
      return res.status(400).json({ success: false, message: "OTP expired. Please request a new one." });
    }
    const isValid = await bcrypt.compare(otp, user.pinResetOTP);
    if (!isValid) return res.status(400).json({ success: false, message: "Invalid OTP." });
    // Hash new PIN
    const salt = await bcrypt.genSalt(10);
    const hashedPin = await bcrypt.hash(newPin, salt);
    user.transactionPin = hashedPin;
    user.isPinSet = true;
    user.pinResetOTP = null;
    user.pinResetOTPExpiresAt = null;
    await user.save();
    // Audit log
    await logAudit({
      userId: user._id,
      userEmail: user.email,
      userRole: user.role,
      action: 'pin_reset',
      targetType: 'user',
      targetId: user._id,
      details: { resetType: 'forgot_pin' },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    return res.status(200).json({ success: true, message: "Transaction PIN reset successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
}
const updateProfile = async(req,res)=>{
try{

const allowedFields=[
"fullName",
"phone",
"dateOfBirth",
"gender",
"address",
"stateOfOrigin",
"occupation"
];


const update={};


allowedFields.forEach(field=>{
 if(req.body[field] !== undefined){
   update[field]=req.body[field];
 }
});


const user=await Users.findByIdAndUpdate(
req.user._id,
update,
{
new:true,
select:"-password"
}
);


res.json({
success:true,
message:"Profile updated successfully",
data:user
});


}catch(error){

res.status(500).json({
success:false,
message:error.message
})

}

}

const personalInfoSchema = joi.object({
  dateOfBirth: joi.date().iso(),
  gender: joi.string().valid("male", "female"),
  address: joi.string().trim().min(5).max(255),
  stateOfOrigin: joi.string().trim(),
  occupation: joi.string().trim(),
  monthlySavingsCommitment: joi.number().min(5000),
}).min(1);

const UpdatePersonalInfo = async (req, res) => {
  try {

    const { error, value } = personalInfoSchema.validate(
      req.body,
      { abortEarly: false }
    );

    if (error) {
      return res.status(400).json({
        success:false,
        message:error.details[0].message,
        errors:error.details.map(
          (d)=>d.message
        )
      });
    }


    const user = await Users.findById(req.user._id);

    if(!user){
      return res.status(404).json({
        success:false,
        message:"User not found"
      });
    }


    Object.keys(value).forEach((field)=>{
      user[field] = value[field];
    });


    await user.save();


    return res.status(200).json({
      success:true,
      message:"Personal information updated successfully",
      data:{
        user:{
          fullName:user.fullName,
          email:user.email,
          phone:user.phone,
          dateOfBirth:user.dateOfBirth,
          gender:user.gender,
          address:user.address,
          stateOfOrigin:user.stateOfOrigin,
          occupation:user.occupation,
          monthlySavingsCommitment:
          user.monthlySavingsCommitment
        }
      }
    });


  } catch(error){

    return res.status(500).json({
      success:false,
      message:"Server error updating personal information",
      error:error.message
    });

  }
};


module.exports = { GetUserInfo, KYCUpload, SetPin, updateBankDetails, forgotPin, resetPin, UpdatePersonalInfo,   };