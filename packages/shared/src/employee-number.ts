/**
 * Employee number ("account number") normalisation (attendance spec §3).
 *
 * Employee numbers are stored as strings in one canonical form, `EMP-` followed by six digits
 * (EMP-000123). People may type any of `123`, `000123`, `EMP123`, `emp-000123` or ` EMP 0123 `;
 * all of them mean EMP-000123. Normalisation is purely syntactic and maps every accepted input to
 * exactly one canonical value, so it can never make two different stored numbers match: the
 * lookup that follows is an exact match on the canonical value.
 *
 * Numbers are never converted to integers for storage; leading zeros are only ignored while
 * comparing.
 */

export const EMPLOYEE_NUMBER_PREFIX = 'EMP-';
/** Digits in the canonical form. */
export const EMPLOYEE_NUMBER_DIGITS = 6;
/** Longest raw input considered at all (guards the regex against oversized input). */
export const EMPLOYEE_NUMBER_MAX_INPUT = 32;

/** Canonical stored form: "EMP-" + 6 digits. */
export const ACCOUNT_NUMBER_PATTERN = /^EMP-\d{6}$/;

/** Optional EMP prefix (any case, optional hyphen) followed by digits only. */
const INPUT_PATTERN = /^(?:EMP-?)?(\d+)$/;

/**
 * Returns the canonical employee number for `raw`, or `null` when the input is malformed
 * (letters other than the EMP prefix, symbols, all zeros, or more than six significant digits).
 */
export function normalizeEmployeeNumber(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > EMPLOYEE_NUMBER_MAX_INPUT) return null;
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  const match = INPUT_PATTERN.exec(compact);
  if (!match) return null;
  const significant = match[1]!.replace(/^0+/, '');
  if (significant.length === 0 || significant.length > EMPLOYEE_NUMBER_DIGITS) return null;
  return `${EMPLOYEE_NUMBER_PREFIX}${significant.padStart(EMPLOYEE_NUMBER_DIGITS, '0')}`;
}
