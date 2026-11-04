const express = require("express");
const { upload, kycFileFilter } = require("../Config/cloudinary");
const routeProtect = require("../Middleware/AuthMiddleware");
const {
  GetUserInfo,
  KYCUpload,
  SetPin,
  updateBankDetails,
  forgotPin,
  resetPin,
  UpdatePersonalInfo,
  GetUserDraft,
  SaveUserDraft,
  DeleteUserDraft,
  AcceptTerms,
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

// Server-side draft sync (owner decision #4) — user-scoped, 30-day inactivity expiry
UserRoutes.get('/draft', routeProtect, GetUserDraft);
UserRoutes.put('/draft', routeProtect, SaveUserDraft);
UserRoutes.delete('/draft', routeProtect, DeleteUserDraft);

// Terms & Conditions / Privacy Policy acceptance capture (auth-protected)
UserRoutes.patch('/terms/accept', routeProtect, AcceptTerms);
module.exports = UserRoutes;