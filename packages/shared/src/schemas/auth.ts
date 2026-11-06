import { z } from 'zod';
import { EMPLOYEE_NUMBER_MAX_INPUT, normalizeEmployeeNumber } from '../employee-number';

export { ACCOUNT_NUMBER_PATTERN } from '../employee-number';

/** Shown for any malformed number; it never says whether a well-formed number exists. */
export const INVALID_EMPLOYEE_NUMBER_MESSAGE =
  'Enter a valid employee number, e.g. 123 or EMP-000123';

/**
 * Employee account numbers are system-assigned: "EMP-" followed by 6 digits (e.g. EMP-000123).
 * Accepts the shortcuts described in `normalizeEmployeeNumber` and outputs the canonical form.
 */
export const accountNumberSchema = z
  .string()
  .max(EMPLOYEE_NUMBER_MAX_INPUT, INVALID_EMPLOYEE_NUMBER_MESSAGE)
  .transform((raw, ctx) => {
    const canonical = normalizeEmployeeNumber(raw);
    if (canonical === null) {
      ctx.addIssue({ code: 'custom', message: INVALID_EMPLOYEE_NUMBER_MESSAGE });
      return z.NEVER;
    }
    return canonical;
  });

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Password policy: length is the primary control (NIST SP 800-63B); we additionally require
 * mixed character classes because the spec targets an environment with shared kiosks.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v), 'Use both upper- and lower-case letters')
  .refine((v) => /\d/.test(v), 'Include at least one number');

/** Returns true for PINs that are trivially guessable (all same digit, ascending/descending runs). */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const digits = pin.split('').map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1]! + 1) % 10);
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1]! + 9) % 10);
  return ascending || descending;
}

export const pinSchema = z
  .string()
  .regex(/^\d{6}$/, 'PIN must be exactly 6 digits')
  .refine((p) => !isWeakPin(p), 'PIN is too easy to guess');

export const loginSchema = z.object({
  accountNumber: accountNumberSchema,
  // Do not apply the password policy at login: legacy/temporary passwords must still be accepted.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^(\d{6}|[A-Z0-9]{4}-[A-Z0-9]{4})$/i, 'Enter the 6-digit code or a recovery code'),
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'New password must differ from the current password',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const changePinSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPin: pinSchema,
});
export type ChangePinInput = z.infer<typeof changePinSchema>;

export const passwordRecoveryRequestSchema = z.object({ accountNumber: accountNumberSchema });
export type PasswordRecoveryRequestInput = z.infer<typeof passwordRecoveryRequestSchema>;

export const passwordRecoveryCompleteSchema = z.object({
  token: z.string().min(32).max(128),
  newPassword: passwordSchema,
});
export type PasswordRecoveryCompleteInput = z.infer<typeof passwordRecoveryCompleteSchema>;

/** Shape of `GET /auth/me`. */
export interface CurrentUser {
  id: string;
  employeeId: string;
  accountNumber: string;
  fullName: string;
  email: string;
  role: { key: string; name: string };
  permissions: string[];
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  mfaRequired: boolean;
}

export type LoginResult =
  | { status: 'AUTHENTICATED'; user: CurrentUser }
  | { status: 'MFA_REQUIRED' }
  | { status: 'MFA_ENROLLMENT_REQUIRED' };
