import { z } from 'zod';

/**
 * Every configurable company policy, with its schema and safe default. Adding a key here is the
 * only step needed to make a new setting readable/writable; unknown keys are rejected.
 */
export const SETTING_DEFINITIONS = {
  'company.name': { schema: z.string().min(1).max(200), default: 'Company' },
  'company.timezone': {
    schema: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown IANA timezone'),
    default: 'Asia/Manila',
  },
  'company.allowedEmailDomains': {
    schema: z
      .array(
        z
          .string()
          .toLowerCase()
          .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Invalid domain'),
      )
      .min(1),
    default: ['example.com'],
  },
  'security.loginMaxAttempts': { schema: z.number().int().min(3).max(20), default: 5 },
  'security.lockoutMinutes': { schema: z.number().int().min(1).max(1440), default: 15 },
  'security.pinMaxAttempts': { schema: z.number().int().min(3).max(20), default: 5 },
  'security.pinLockoutMinutes': { schema: z.number().int().min(1).max(1440), default: 15 },
  'security.sessionIdleMinutes': { schema: z.number().int().min(5).max(480), default: 30 },
  'security.sessionAbsoluteHours': { schema: z.number().int().min(1).max(72), default: 12 },
  'security.tempPasswordTtlHours': { schema: z.number().int().min(1).max(168), default: 24 },
  'security.passwordResetTtlMinutes': { schema: z.number().int().min(5).max(240), default: 30 },
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_DEFINITIONS)[K]['schema']>;

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFINITIONS, key);
}
