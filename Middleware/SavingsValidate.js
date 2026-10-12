const Joi = require("joi");
const AppError = require("../Utilis/AppError");
const formatValidationError = require("../Utilis/formatValidationError");

const withdrawRequestSchema = Joi.object({
  amount: Joi.number().positive().min(100).required(),
  accountNumber: Joi.string().trim().pattern(/^\d{10}$/).required().messages({
    "string.pattern.base": "Account number must be a valid 10-digit NUBAN number.",
  }),
  accountName: Joi.string().trim().min(3).max(100).required(),
  bankName: Joi.string().trim().min(2).max(100).required(),
  pin: Joi.string().trim().required(),
});

const directWithdrawSchema = Joi.object({
  amount: Joi.number().positive().min(100).required(),
  pin: Joi.string().trim().required(),
  method: Joi.string().trim().optional(),
  bankDetails: Joi.object().optional(),
});

const tierCommitmentSchema = Joi.object({
  newTier: Joi.string().trim().valid("bronze", "silver", "gold", "platinum", "Bronze", "Silver", "Gold", "Platinum").required(),
  newCommitment: Joi.number().positive().required(),
});

const verifyMembershipFeeSchema = Joi.object({
  reference: Joi.string().trim().optional(),
  tx_ref: Joi.string().trim().optional(),
  transaction_id: Joi.alternatives().try(Joi.string().trim(), Joi.number()).optional(),
  transactionId: Joi.alternatives().try(Joi.string().trim(), Joi.number()).optional(),
}).or("reference", "tx_ref", "transaction_id", "transactionId");

const validateWithdrawRequest = (req, res, next) => {
  const { error, value } = withdrawRequestSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const validateDirectWithdraw = (req, res, next) => {
  const { error, value } = directWithdrawSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const validateTierCommitment = (req, res, next) => {
  const { error, value } = tierCommitmentSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const validateVerifyMembershipFee = (req, res, next) => {
  const { error, value } = verifyMembershipFeeSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const SavingsValidate = {
  validateWithdrawRequest,
  validateDirectWithdraw,
  validateTierCommitment,
  validateVerifyMembershipFee,
};

module.exports = SavingsValidate;
