import { describe, expect, it } from 'vitest';
import {
  formatMultiplier,
  formatPercent,
  formatPeso,
  parseMultiplier,
  parsePercent,
  parsePeso,
} from '@/lib/money';

describe('money helpers', () => {
  it('formats and parses pesos without floating point', () => {
    expect(formatPeso(123_450)).toBe('₱1,234.50');
    expect(formatPeso(-5)).toBe('−₱0.05');
    expect(parsePeso('1,234.5')).toBe(123_450);
    expect(parsePeso('₱0.07')).toBe(7);
    expect(parsePeso('0.1')).toBe(10);
    expect(parsePeso('12.345')).toBeNull();
    expect(parsePeso('-1')).toBeNull();
    expect(parsePeso('abc')).toBeNull();
  });
  it('converts percentages and multipliers', () => {
    expect(parsePercent('4.5')).toBe(450);
    expect(parsePercent('2.25%')).toBe(225);
    expect(formatPercent(450)).toBe('4.5%');
    expect(formatPercent(1000)).toBe('10%');
    expect(parseMultiplier('1.25')).toBe(1250);
    expect(parseMultiplier('2')).toBe(2000);
    expect(formatMultiplier(1250)).toBe('1.25×');
    expect(formatMultiplier(1000)).toBe('1×');
  });
});
