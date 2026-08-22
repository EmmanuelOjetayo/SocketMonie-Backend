/**
 * Express 5 Compatible MongoDB Operator Injection Sanitizer
 * Safely mutates req.body, req.params, req.headers, and req.query in-place
 * to remove keys starting with '$' or containing '.' without attempting to
 * reassign Express 5 read-only getters like req.query.
 */
function sanitizeInPlace(obj) {
  if (!obj || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      obj[i] = sanitizeInPlace(obj[i]);
    }
    return obj;
  }

  for (const key of Object.keys(obj)) {
    if (key.startsWith("$") || key.includes(".")) {
      delete obj[key];
    } else {
      obj[key] = sanitizeInPlace(obj[key]);
    }
  }
  return obj;
}

const mongoSanitizeExpress5 = (req, res, next) => {
  if (req.body) sanitizeInPlace(req.body);
  if (req.params) sanitizeInPlace(req.params);
  if (req.headers) sanitizeInPlace(req.headers);
  if (req.query) sanitizeInPlace(req.query);
  next();
};

module.exports = mongoSanitizeExpress5;
