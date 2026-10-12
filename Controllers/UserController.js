const { UserService } = require("../Services/UserService.js")
const GetUserInfo = async (req, res) => {
  try {
    const userObj = await UserService.UserInfo(req.user._id)
    console.log("userObj", userObj);

    if (!userObj) {
    return res.status(404).json({
        success: false,
        message: "User not found"
    });
}

    return res.status(200).json({ success: true, data: { user: userObj } });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
};


const KYCUpload = async (req, res) => {
  try {

  const response = await UserService.KYCUploadService(req.body, req.file, req.user._id)

    return res.status(200).json({
      success: true,
      message: 'KYC Document uploaded successfully! \n Please refresh for update',
      data: response
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.statusCode ? err.message : 'Failed to upload KYC document',
      error: err.statusCode ? undefined : err.message,
    });
  }
};


const SetPin = async (req, res) => {
  try {
    
    const response = await UserService.SetPinService(req.body, req.user._id)

    return res.status(200).json({ success: true, message: 'Transaction PIN created successfully!', data: response});
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};


const updateBankDetails = async (req,res)=>{
  try{
    const response = await UserService.BankDetailService(req.body, req.user._id)
    res.json({
      success:true,
      message:"Bank account verified and saved",
      data: response
    });


  }catch(error){
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });

  }

}

// Forgot PIN
const forgotPin = async (req, res) => {
  try {
    await UserService.ForgotPin(req.body)

    return res.status(200).json({ success: true, message: "PIN reset OTP sent to your email." });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

// Reset PIN
const resetPin = async (req, res) => {
  try {

    await UserService.ResetPin(req.body, req.user._id, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return res.status(200).json({ success: true, message: "Transaction PIN reset successfully." });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
}
const updateProfile = async(req,res)=>{
try{

  const response = await UserService.UpdateProfile(req.body, req.user._id)

  res.json({success:true,message:"Profile updated successfully", data:response });


}catch(error){
return res.status(error.statusCode || 500).json({
  success: false,
  message: error.message,
})

}

}



const UpdatePersonalInfo = async (req, res) => {
  try {

    const response = await UserService.UpdatePersonalInfo(req.body, req.user._id)

    return res.status(200).json({
      success:true,
      message:"Personal information updated successfully.\n Please Refresh to see changes",
      data:response
    });


  } catch(error){

    return res.status(error.statusCode || 500).json({
      success:false,
      message:"Server error updating personal information",
      error:error.message
    });

  }
};


module.exports = { GetUserInfo, KYCUpload, SetPin, updateBankDetails, forgotPin, resetPin, UpdatePersonalInfo,  updateProfile };