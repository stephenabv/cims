import { passwordSchema } from '@cims/shared';
import {
  generateRecoveryCode,
  generateTemporaryPassword,
  isRecoveryCodeFormat,
} from './recovery-codes';

describe('credential generators', () => {
  it('produces recovery codes in XXXX-XXXX format', () => {
    for (let i = 0; i < 50; i++) expect(isRecoveryCodeFormat(generateRecoveryCode())).toBe(true);
  });

  it('produces temporary passwords that satisfy the password policy', () => {
    for (let i = 0; i < 200; i++)
      expect(passwordSchema.safeParse(generateTemporaryPassword()).success).toBe(true);
  });
});
