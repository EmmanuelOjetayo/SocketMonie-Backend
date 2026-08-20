/**
 * Request validation middleware.
 *
 * Usage:
 *   router.post("/deposit", validate({ amount: "required|monetary|min:100" }), handler);
 *   router.post("/apply", validate({ amount: "required|monetary|min:100", loanType: "required|string" }), handler);
 *
 * Supported rules:
 *   required      – value must be present and non-empty
 *   monetary      – value must be a positive number (auto-coerced)
 *   min:N         – numeric value must be >= N
 *   max:N         – numeric value must be <= N
 *   string        – value must be a string
 *   numeric       – value must be numeric (integer)
 *   minLength:N   – string length must be >= N
 *   maxLength:N   – string length must be <= N
 */

function validate(rules) {
  return (req, res, next) => {
    const errors = [];

    for (const [field, ruleStr] of Object.entries(rules)) {
      const ruleList = ruleStr.split("|");
      const value = req.body[field];

      const isRequired = ruleList.includes("required");

      // If not required and value is missing/empty, skip validation for this field
      if (!isRequired && (value === undefined || value === null || value === "")) {
        continue;
      }

      // Required check
      if (isRequired && (value === undefined || value === null || value === "")) {
        errors.push(`${field} is required`);
        continue;
      }

      // Type checks
      for (const rule of ruleList) {
        if (rule === "required") continue;

        if (rule === "string") {
          if (typeof value !== "string") {
            errors.push(`${field} must be a string`);
          }
          continue;
        }

        if (rule === "numeric") {
          const num = Number(value);
          if (!Number.isInteger(num)) {
            errors.push(`${field} must be a whole number`);
          }
          // Store coerced value
          req.body[field] = num;
          continue;
        }

        if (rule === "monetary") {
          const num = Number(value);
          if (isNaN(num) || num <= 0) {
            errors.push(`${field} must be a valid positive amount`);
          }
          // Store coerced numeric value
          req.body[field] = num;
          continue;
        }

        // Min numeric
        const minMatch = rule.match(/^min:(\d+)$/);
        if (minMatch) {
          const minVal = parseInt(minMatch[1], 10);
          const num = Number(req.body[field] ?? value);
          if (isNaN(num) || num < minVal) {
            errors.push(`${field} must be at least ${minVal}`);
          }
          continue;
        }

        // Max numeric
        const maxMatch = rule.match(/^max:(\d+)$/);
        if (maxMatch) {
          const maxVal = parseInt(maxMatch[1], 10);
          const num = Number(req.body[field] ?? value);
          if (isNaN(num) || num > maxVal) {
            errors.push(`${field} must not exceed ${maxVal}`);
          }
          continue;
        }

        // Min length (string)
        const minLenMatch = rule.match(/^minLength:(\d+)$/);
        if (minLenMatch) {
          const minLen = parseInt(minLenMatch[1], 10);
          if (typeof value !== "string" || value.length < minLen) {
            errors.push(`${field} must be at least ${minLen} characters`);
          }
          continue;
        }

        // Max length (string)
        const maxLenMatch = rule.match(/^maxLength:(\d+)$/);
        if (maxLenMatch) {
          const maxLen = parseInt(maxLenMatch[1], 10);
          if (typeof value !== "string" || value.length > maxLen) {
            errors.push(`${field} must not exceed ${maxLen} characters`);
          }
          continue;
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors,
      });
    }

    next();
  };
}

module.exports = validate;
