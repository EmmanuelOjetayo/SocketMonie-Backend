const joi = require("joi");
const AppError = require("../Utilis/AppError")
const formatValidationError = require("../Utilis/formatValidationError");

   const loginSchema = joi.object({
      email: joi.string().trim().email().lowercase().required(),
      password: joi.string().required(),
    });
    
const LoginValidate = async(req, res, next)=>{
    

    const { error, value } = loginSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      throw new AppError(formatValidationError(error), 400);
    }

    req.body = value
    next()
}


const signUpSchema = joi.object({
  fullName: joi.string().trim().min(3).max(100).required(),
  email: joi.string().trim().email().lowercase().required(),
  phone: joi.string().trim().pattern(/^\d{11}$/).required(),
  referralCode: joi.string().trim().uppercase().required(), // Code of referring member
  password: joi.string()
    .min(8)
    .max(30)
    .pattern(/[A-Z]/)
    .pattern(/[0-9]/)
    .pattern(/[!@#$%^&*(),.?":{}|<>]/)
    .required(),
});


const RegisterValidate = async(req, res, next)=>{
 const { error, value } = signUpSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      throw new AppError(formatValidationError(error), 400);
    }

    
    req.body = value;
    next()
}


const verifyOtpSchema = joi.object({ 
  email: joi.string().email().required(), 
  otp: joi.string().length(4).required() 
});

const VerifyOtpValidate = async(req, res, next)=>{
   const { error, value } = verifyOtpSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
      if (error) {
        throw new AppError(formatValidationError(error), 400);
    }

       req.body = value
      next()
}



const forgotPasswordSchema = joi.object({ email: joi.string().email().required() });
const ForgotPassValidate = async(req, res, next) =>{   
  const { error, value } = forgotPasswordSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
      if (error) {
        throw new AppError(formatValidationError(error), 400);
    }

       req.body = value
      next()
}

const resetPasswordSchema = joi.object({
  email: joi.string().trim().email().lowercase().required(),
  otp: joi.string().length(4).required(),
  newPassword: joi.string()
    .min(8)
    .max(30)
    .pattern(/[A-Z]/)
    .pattern(/[0-9]/)
    .pattern(/[!@#$%^&*(),.?":{}|<>]/)
    .required(),
});

const ResetPasswordValidate = async(req, res, next) => {
  const { error, value } = resetPasswordSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }

  req.body = value;
  next();
}

const AuthValidator = {
    LoginValidate,
    RegisterValidate,
    VerifyOtpValidate,
    ForgotPassValidate,
    ResetPasswordValidate
}


module.exports = { AuthValidator }