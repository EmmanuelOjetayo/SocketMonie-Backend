const Joi = require("joi");
const AppError = require("../Utilis/AppError");
const formatValidationError = require("../Utilis/formatValidationError");

/**
 * Mask an account number for logs: keeps first 4 + last 4 so the developer
 * can confirm the input that was actually received, without exposing the
 * full number in production logs. NEVER log the full account number.
 */
const maskAccount = (num) => {
  const s = String(num || "");
  if (s.length <= 8) return `len=${s.length}`;
  return `${s.slice(0, 4)}****${s.slice(-4)} (len=${s.length})`;
};

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
    const raw = req.body || {};
    console.log(
      `[BANK] verify-bank validation failed | bankCode: ${raw.bankCode || "—"} | accountNumber: ${maskAccount(raw.accountNumber)} | error: ${error.message}`
    );
    throw new AppError(formatValidationError(error), 400);
  }
  console.log(
    `[BANK] verify-bank validation passed | bankCode: ${value.bankCode} | accountNumber: ${maskAccount(value.accountNumber)} | body: ${JSON.stringify({ accountNumber: maskAccount(value.accountNumber), bankCode: value.bankCode })}`
  );
  req.body = value;
  next();
};

const PaymentValidate = {
  validateInitiateDeposit,
  validateVerifyDeposit,
  validateVerifyBank,
};

module.exports = PaymentValidate;
