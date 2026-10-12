const joi = require("joi")

const AppError = require("../Utilis/AppError");
const formatValidationError = require("../Utilis/formatValidationError");
const kycSchema = joi.object({
  documentType: joi.string().valid('nin', 'voters_card', 'passport', 'drivers_license').required(),
  bvn: joi.string().pattern(/^\d{11}$/).optional(),
  nin: joi.string().pattern(/^\d{11}$/).optional(),
});

const KYCUploadValidate = (req, res, next) => {
        if (!req.file) throw new AppError('Please upload a document file', 400);

    const { error, value } = kycSchema.validate(req.body);
    if (error) {
        throw new AppError(formatValidationError(error), 400);
        }

    req.body = value;
    next();
}


const pinSchema = joi.object({
  pin: joi.string().length(4).pattern(/^[0-9]+$/).required(),
});

const SetPinValidate = (req, res, next) => {
    const { error, value } = pinSchema.validate(req.body);
     if (error) {
      throw new AppError(formatValidationError(error), 400);
    }

    req.body = value;
    next();

}

const bankDetailsSchema = joi.object({
  bankName: joi.string().required(),
  bankCode: joi.string().required(),
  accountName: joi.string().required(),
  accountNumber: joi.string().pattern(/^\d{10}$/).required(),
});


const BankDetailsValidate = (req, res, next) => {
    const { error, value } = bankDetailsSchema.validate(req.body);
     if (error) {
      throw new AppError(formatValidationError(error), 400);
    }

    req.body = value;
    next();
}



const forgotPinSchema = joi.object({
  email: joi.string().email().required(),
});

const resetPinSchema = joi.object({
  email: joi.string().email().required(),
  otp: joi.string().length(4).required(),
  newPin: joi.string().length(4).pattern(/^[0-9]+$/).required(),
});


const ForgotPinValidate = (req, res, next) => {
    const { error, value } = forgotPinSchema.validate(req.body);
     if (error) {
      throw new AppError(formatValidationError(error), 400);
    }

    req.body = value;
    next();
}

const ResetPinValidate = (req, res, next) => {
    const { error, value } = resetPinSchema.validate(req.body);
     if (error) {
      throw new AppError(formatValidationError(error), 400);
    }

    req.body = value;
    next();
}


const UpdatePersonalInfoSchema = joi.object({
  dateOfBirth: joi.date().iso(),
  gender: joi.string().valid("male", "female"),
  address: joi.string().trim().min(5).max(255),
  stateOfOrigin: joi.string().trim(),
  occupation: joi.string().trim(),
  monthlySavingsCommitment: joi.number().min(5000),
}).min(1);


const UpdatePersonalInfoValidate = (req, res, next) => {
    const { error, value } = UpdatePersonalInfoSchema.validate(req.body);
     if (error) {
      throw new AppError(formatValidationError(error), 400);
    }

    req.body = value;
    next();
}

const UserValidator = {
    KYCUploadValidate,
    SetPinValidate,
    BankDetailsValidate,
    ResetPinValidate,
    ForgotPinValidate,
    UpdatePersonalInfoValidate
}
module.exports = UserValidator;