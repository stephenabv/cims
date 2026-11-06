import type {
  PayItemDirection,
  PaySchedule,
  PayWarningCode,
  UndertimePolicyKind,
} from '@cims/shared';

export const PAY_SCHEDULE: Record<PaySchedule, string> = {
  SEMI_MONTHLY: 'Semi-monthly (1–15, 16–end)',
  ROLLING_15_DAY: 'Every 15 days',
  MONTHLY: 'Monthly',
};

export const UNDERTIME_KIND: Record<UndertimePolicyKind, string> = {
  HOURLY_EQUIVALENT: 'Hourly-rate equivalent',
  FIXED_PER_BLOCK: 'Fixed amount per block of minutes',
  TIERED: 'Company table (tiers)',
};

export const ITEM_DIRECTION: Record<PayItemDirection, string> = {
  ALLOWANCE: 'Allowance',
  DEDUCTION: 'Deduction',
};

export const WARNING_TITLE: Record<PayWarningCode, string> = {
  NO_PROFILE: 'No pay terms',
  INCOMPLETE_DAY: 'Missing punch',
  PENDING_OVERTIME: 'Overtime awaiting approval',
  NEGATIVE_NET: 'Negative net pay',
};
