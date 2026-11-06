import { describe, expect, it } from 'vitest';
import { normalizeEmployeeNumber } from './employee-number';
import { accountNumberSchema } from './schemas/auth';

describe('normalizeEmployeeNumber', () => {
  it.each([
    ['1', 'EMP-000001'],
    ['000001', 'EMP-000001'],
    ['EMP000001', 'EMP-000001'],
    ['EMP1', 'EMP-000001'],
    ['emp1', 'EMP-000001'],
    ['EMP-000001', 'EMP-000001'],
    ['emp-1', 'EMP-000001'],
    ['1025', 'EMP-001025'],
    ['EMP001025', 'EMP-001025'],
    ['  1025  ', 'EMP-001025'],
    [' EMP 00 1025\t', 'EMP-001025'],
    ['999999', 'EMP-999999'],
    ['0000999999', 'EMP-999999'],
  ])('maps %j to %s', (raw, canonical) => {
    expect(normalizeEmployeeNumber(raw)).toBe(canonical);
  });

  it.each([
    '',
    '   ',
    '0',
    '000000',
    'EMP',
    'EMP-',
    'EMP0',
    '1234567',
    'EMP-1234567',
    'EM1',
    'XYZ-000123',
    '12a',
    '1-2',
    'EMP--1',
    '-1',
    '+1',
    '1.0',
    '１２３', // full-width digits are not ASCII digits
    "1' OR '1'='1",
    'EMP-000001; DROP TABLE employee',
    '9'.repeat(40),
  ])('rejects %j', (raw) => {
    expect(normalizeEmployeeNumber(raw)).toBeNull();
  });

  it('never maps two different canonical numbers onto each other', () => {
    // Every canonical number normalises to itself, and every shortcut of n maps to n only.
    const seen = new Map<string, number>();
    for (let n = 1; n <= 20_000; n += 1) {
      const canonical = `EMP-${String(n).padStart(6, '0')}`;
      expect(normalizeEmployeeNumber(canonical)).toBe(canonical);
      for (const raw of [String(n), `EMP${n}`, String(n).padStart(6, '0')]) {
        const out = normalizeEmployeeNumber(raw)!;
        const owner = seen.get(out);
        if (owner !== undefined) expect(owner).toBe(n);
        seen.set(out, n);
      }
    }
    expect(seen.size).toBe(20_000);
  });
});

describe('accountNumberSchema', () => {
  it('outputs the canonical form', () => {
    expect(accountNumberSchema.parse('emp1')).toBe('EMP-000001');
  });
  it('uses one generic message for every malformed number', () => {
    const a = accountNumberSchema.safeParse('abc');
    const b = accountNumberSchema.safeParse('1234567');
    expect(a.success || b.success).toBe(false);
    expect(a.error?.issues[0]?.message).toBe(b.error?.issues[0]?.message);
  });
});
