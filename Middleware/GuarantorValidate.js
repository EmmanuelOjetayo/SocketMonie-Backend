const Joi = require("joi");
const AppError = require("../Utilis/AppError");
const formatValidationError = require("../Utilis/formatValidationError");

const respondGuarantorSchema = Joi.object({
  token: Joi.string().trim().required(),
  decision: Joi.string().trim().valid("accept", "reject").required(),
  address: Joi.string().trim().allow("").optional(),
  occupation: Joi.string().trim().allow("").optional(),
  employerName: Joi.string().trim().allow("").optional(),
  idType: Joi.string().trim().allow("").optional(),
  idNumber: Joi.string().trim().allow("").optional(),
  idCardUrl: Joi.string().trim().allow("").optional(),
  proofOfAddressUrl: Joi.string().trim().allow("").optional(),
  signatureUrl: Joi.string().trim().allow("").optional(),
});

const validateRespondGuarantor = (req, res, next) => {
  const { error, value } = respondGuarantorSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const GuarantorValidate = {
  validateRespondGuarantor,
};

module.exports = GuarantorValidate;
