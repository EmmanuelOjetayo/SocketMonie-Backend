const fieldLabels = {
  fullName: "Full name",
  email: "Email",
  phone: "Phone number",
  referralCode: "Referral code",
  password: "Password",
  newPassword: "New password",
  documentType: "Document type",
  bvn: "BVN",
  nin: "NIN",
  otp: "Verification code",
  newPin: "New PIN",
  pin: "PIN",
  bankName: "Bank name",
  bankCode: "Bank code",
  accountName: "Account name",
  accountNumber: "Account number",
  dateOfBirth: "Date of birth",
  gender: "Gender",
  address: "Address",
  stateOfOrigin: "State of origin",
  occupation: "Occupation",
  monthlySavingsCommitment: "Monthly savings commitment",
};

const getReadableRuleMessage = (detail) => {
  const limit = detail.context?.limit;

  switch (detail.type) {
    case "any.required":
    case "string.empty":
      return "is required";
    case "string.email":
      return "must be a valid email address";
    case "string.min":
      return `must be at least ${limit} characters`;
    case "string.max":
      return `must not exceed ${limit} characters`;
    case "string.length":
      return `must be exactly ${limit} characters`;
    case "string.pattern.base":
      return "has an invalid format";
    case "string.base":
      return "must be text";
    case "number.min":
      return `must be at least ${limit}`;
    case "date.format":
      return "must be a valid date";
    case "any.only":
      return "contains an invalid option";
    default:
      return detail.message
        .replace(/^"[^"]+"\s*/, "")
        .replace(/^./, (character) => character.toLowerCase())
        .replace(/\s+with value .*$/, " has an invalid value");
  }
};

const formatValidationError = (error) => {
  const messages = error.details.map((detail) => {
    const field = detail.path.join(".");
    const label = fieldLabels[field] || field || "Value";
    const message = getReadableRuleMessage(detail);

    return `${label}: ${message}`;
  });

  return `Please correct the following: ${messages.join("; ")}`;
};

module.exports = formatValidationError;
