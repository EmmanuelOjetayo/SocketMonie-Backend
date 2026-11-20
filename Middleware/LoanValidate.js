const Joi = require("joi");
const AppError = require("../Utilis/AppError");
const formatValidationError = require("../Utilis/formatValidationError");

const MAX_TRANSACTION_AMOUNT = 50000000;

const applyLoanSchema = Joi.object({
  amount: Joi.number().positive().min(100).max(MAX_TRANSACTION_AMOUNT).required(),
  durationMonths: Joi.number().integer().min(1).max(12).required(),
  loanType: Joi.string().trim().valid("cooperative", "emergency", "personal", "business").default("cooperative"),
  disbursementMethod: Joi.string().trim().optional(),
  purpose: Joi.string().trim().allow("").optional(),
  guarantorReferralCodes: Joi.array()
    .items(Joi.string().trim().uppercase())
    .length(4)
    .unique()
    .required()
    .messages({
      "array.length": "Exactly four guarantor referral codes are required.",
      "array.unique": "Four different guarantor referral codes are required.",
    }),
});

const replaceGuarantorSchema = Joi.object({
  oldGuarantorUserId: Joi.string().trim().required(),
  newGuarantorReferralCode: Joi.string().trim().uppercase().required(),
  reason: Joi.string().trim().allow("").optional(),
});

const repayInitializeSchema = Joi.object({
  loanId: Joi.string().trim().required(),
  paymentAmount: Joi.number().positive().min(100).max(MAX_TRANSACTION_AMOUNT).required(),
});

const validateApplyLoan = (req, res, next) => {
  const { error, value } = applyLoanSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const validateReplaceGuarantor = (req, res, next) => {
  const { error, value } = replaceGuarantorSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const validateRepayInitialize = (req, res, next) => {
  const { error, value } = repayInitializeSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const cancelLoanSchema = Joi.object({
  reason: Joi.string().trim().allow("").max(500).optional(),
});

const validateCancelLoan = (req, res, next) => {
  const { error, value } = cancelLoanSchema.validate(req.body || {}, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const LoanValidate = {
  validateApplyLoan,
  validateReplaceGuarantor,
  validateRepayInitialize,
  validateCancelLoan,
};

module.exports = LoanValidate;
