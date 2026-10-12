const Joi = require("joi");
const AppError = require("../Utilis/AppError");
const formatValidationError = require("../Utilis/formatValidationError");

const reasonSchema = Joi.object({
  reason: Joi.string().trim().min(3).required().messages({
    "any.required": "Reason is required.",
    "string.empty": "Reason is required.",
  }),
});

const systemSettingsSchema = Joi.object({
  loanTiers: Joi.object({
    firstLoan: Joi.number().positive().optional(),
    secondLoan: Joi.number().positive().optional(),
    thirdLoan: Joi.number().positive().optional(),
  }).optional(),
  interestRates: Joi.object({
    bronze: Joi.number().min(0).optional(),
    silver: Joi.number().min(0).optional(),
    gold: Joi.number().min(0).optional(),
    platinum: Joi.number().min(0).optional(),
  }).optional(),
  eligibility: Joi.object({
    minSavings: Joi.number().positive().optional(),
    minMonths: Joi.number().integer().min(1).optional(),
  }).optional(),
  withdrawalFee: Joi.number().min(0).optional(),
  latePenaltyRate: Joi.number().min(0).optional(),
});

const validateReason = (req, res, next) => {
  const { error, value } = reasonSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const validateSystemSettings = (req, res, next) => {
  const { error, value } = systemSettingsSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const AdminValidate = {
  validateReason,
  validateSystemSettings,
};

module.exports = AdminValidate;
