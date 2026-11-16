/**
 * Age validation helpers (minimum registration age gate).
 *
 * SocketMonnie only allows individuals who are at least 18 years old to
 * create accounts. The gate is enforced here (server-side, source of truth)
 * so a client cannot bypass it via the `max` attribute of a date input or by
 * simply omitting the field.
 *
 * Dates are handled as calendar dates (UTC midnight) so timezone shifts never
 * move an applicant's birth date by a day and change eligibility.
 */

const MINIMUM_REGISTRATION_AGE = 18;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const atUtcMidnight = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  const time = d.getTime();
  if (Number.isNaN(time)) return null;
  // Normalise to UTC midnight so TZ boundaries never skew comparisons.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/**
 * Parses a birth date (ISO string or Date) into a UTC-midnight timestamp.
 * Returns null when the value is missing/invalid.
 */
const parseDobUtcMidnight = (dob) => {
  if (dob === null || dob === undefined) return null;
  const d = dob instanceof Date ? dob : new Date(dob);
  const time = d.getTime();
  if (Number.isNaN(time)) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/**
 * Calculates whole years elapsed since the (UTC-midnight) birth date.
 * Returns null when the birth date is invalid.
 */
const calculateAge = (dob) => {
  const dobUtc = parseDobUtcMidnight(dob);
  if (dobUtc === null) return null;

  const birth = new Date(dobUtc);
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
  const dayDiff = now.getUTCDate() - birth.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1;
  return age;
};

/**
 * True when the birth date is a real calendar date that is not in the future
 * (compared at UTC midnight) and the applicant has already reached the minimum
 * age of 18.
 */
const isEligibleDob = (dob) => {
  const dobUtc = parseDobUtcMidnight(dob);
  if (dobUtc === null) return false;
  const nowUtcMidnight = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate()
  );
  if (dobUtc > nowUtcMidnight) return false; // future / invalid dates
  const age = calculateAge(dob);
  return age !== null && age >= MINIMUM_REGISTRATION_AGE;
};

module.exports = {
  MINIMUM_REGISTRATION_AGE,
  MS_PER_DAY,
  parseDobUtcMidnight,
  calculateAge,
  isEligibleDob,
};
