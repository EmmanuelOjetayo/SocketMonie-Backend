const Joi = require("joi");
const AppError = require("../Utilis/AppError");
const formatValidationError = require("../Utilis/formatValidationError");

const initiateDepositSchema = Joi.object({
  amount: Joi.number().positive().min(100).required(),
  method: Joi.string().trim().optional(),
});

const verifyDepositSchema = Joi.object({
  reference: Joi.string().trim().optional(),
  tx_ref: Joi.string().trim().optional(),
  transaction_id: Joi.alternatives().try(Joi.string().trim(), Joi.number()).optional(),
  transactionId: Joi.alternatives().try(Joi.string().trim(), Joi.number()).optional(),
}).or("reference", "tx_ref", "transaction_id", "transactionId");

const verifyBankSchema = Joi.object({
  accountNumber: Joi.string().trim().pattern(/^\d{10}$/).required().messages({
    "string.pattern.base": "Account number must be a valid 10-digit NUBAN number.",
  }),
  bankCode: Joi.string().trim().required(),
});

const validateInitiateDeposit = (req, res, next) => {
  const { error, value } = initiateDepositSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const validateVerifyDeposit = (req, res, next) => {
  const { error, value } = verifyDepositSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const validateVerifyBank = (req, res, next) => {
  const { error, value } = verifyBankSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new AppError(formatValidationError(error), 400);
  }
  req.body = value;
  next();
};

const PaymentValidate = {
  validateInitiateDeposit,
  validateVerifyDeposit,
  validateVerifyBank,
};

module.exports = PaymentValidate;
