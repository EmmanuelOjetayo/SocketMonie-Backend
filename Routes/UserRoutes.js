const express = require("express");
const { upload } = require("../Config/cloudinary");
const routeProtect = require("../Middleware/AuthMiddleware");
const {
  GetUserInfo,
  OnboardInfo,
  KYCUpload,
  SetPin,
  updateBankDetails,
  forgotPin,
  resetPin,
  UpdatePersonalInfo,
} = require("../Controllers/UserController");
const UserRoutes = express.Router();

UserRoutes.get('/me', routeProtect, GetUserInfo);
UserRoutes.patch("/personal-info", routeProtect, UpdatePersonalInfo);
UserRoutes.post('/kyc', routeProtect, upload.single('file'), KYCUpload);
UserRoutes.post('/pin', routeProtect, SetPin);
UserRoutes.post('/pin/forgot', forgotPin);
UserRoutes.post('/pin/reset', routeProtect, resetPin);
UserRoutes.put('/bank-details', routeProtect, updateBankDetails);
module.exports = UserRoutes;