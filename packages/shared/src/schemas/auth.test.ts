import { describe, expect, it } from 'vitest';
import { accountNumberSchema, isWeakPin, passwordSchema, pinSchema } from './auth';

describe('accountNumberSchema', () => {
  it('normalises case and whitespace', () => {
    expect(accountNumberSchema.parse('  emp-000123 ')).toBe('EMP-000123');
  });
  it.each(['EMP-123', '000123', 'EMP-0001234', 'XYZ-000123'])('rejects %s', (v) => {
    expect(accountNumberSchema.safeParse(v).success).toBe(false);
  });
});

describe('PIN rules', () => {
  it.each(['000000', '999999', '123456', '234567', '890123', '654321', '210987'])(
    'flags %s as weak',
    (pin) => expect(isWeakPin(pin)).toBe(true),
  );
  it.each(['482915', '102938', '135790'])('accepts %s', (pin) => {
    expect(isWeakPin(pin)).toBe(false);
    expect(pinSchema.safeParse(pin).success).toBe(true);
  });
  it.each(['12345', '1234567', '12a456', ''])('rejects malformed %s', (pin) => {
    expect(pinSchema.safeParse(pin).success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it('accepts a compliant password', () => {
    expect(passwordSchema.safeParse('Correct-Horse-9').success).toBe(true);
  });
  it.each(['short1A', 'alllowercase123', 'ALLUPPERCASE123', 'NoDigitsHereAtAll'])(
    'rejects %s',
    (pw) => expect(passwordSchema.safeParse(pw).success).toBe(false),
  );
});
