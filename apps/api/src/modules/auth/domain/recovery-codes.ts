import { randomInt } from 'node:crypto';

/** Crockford-style alphabet without ambiguous characters (0/O, 1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const RECOVERY_CODE_COUNT = 10;

export function generateRecoveryCode(): string {
  const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${pick()}-${pick()}`;
}

export function normaliseRecoveryCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isRecoveryCodeFormat(code: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code.trim());
}

/** Readable random temporary password satisfying the shared password policy. */
export function generateTemporaryPassword(): string {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = lower + upper + digits;
  const chars = [
    lower[randomInt(lower.length)],
    upper[randomInt(upper.length)],
    digits[randomInt(digits.length)],
    ...Array.from({ length: 13 }, () => all[randomInt(all.length)]),
  ] as string[];
  // Fisher–Yates shuffle so the guaranteed classes are not at fixed positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
