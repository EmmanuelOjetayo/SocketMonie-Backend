const express = require("express");
const { upload } = require("../Config/cloudinary");
const routeProtect = require("../Middleware/AuthMiddleware");
const {
  GetUserInfo,
  KYCUpload,
  SetPin,
  updateBankDetails,
  forgotPin,
  resetPin,
  UpdatePersonalInfo,
} = require("../Controllers/UserController");

const  UserValidator = require("../Middleware/UserValidate");
const UserRoutes = express.Router();

UserRoutes.get('/me', routeProtect, GetUserInfo);
UserRoutes.patch("/personal-info", routeProtect, UserValidator.UpdatePersonalInfoValidate, UpdatePersonalInfo);
UserRoutes.post('/kyc', routeProtect, upload.single('file'), UserValidator.KYCUploadValidate, KYCUpload);
UserRoutes.post('/pin', routeProtect, UserValidator.SetPinValidate, SetPin);
UserRoutes.post('/pin/forgot', UserValidator.ForgotPinValidate, forgotPin);
UserRoutes.post('/pin/reset', routeProtect, UserValidator.ResetPinValidate, resetPin);
UserRoutes.put('/bank-details', routeProtect, UserValidator.BankDetailsValidate, updateBankDetails);
module.exports = UserRoutes;