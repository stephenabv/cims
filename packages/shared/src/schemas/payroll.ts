import { z } from 'zod';
import { isoDateSchema, paginationSchema, uuidSchema } from './common';

/**
 * Payroll setup (spec §3.4). All money is integer centavos (₱1.00 = 100); multipliers are per
 * mille (1250 = 1.25×) and percentages are basis points (450 = 4.50%), so no floating point is
 * ever stored or computed.
 */
export const UNDERTIME_POLICY_KINDS = ['HOURLY_EQUIVALENT', 'FIXED_PER_BLOCK', 'TIERED'] as const;
export type UndertimePolicyKind = (typeof UNDERTIME_POLICY_KINDS)[number];

export const OVERTIME_RATE_KINDS = ['MULTIPLIER', 'FIXED'] as const;
export type OvertimeRateKind = (typeof OVERTIME_RATE_KINDS)[number];

export const PAY_SCHEDULES = ['SEMI_MONTHLY', 'ROLLING_15_DAY', 'MONTHLY'] as const;
export type PaySchedule = (typeof PAY_SCHEDULES)[number];

export const PAY_ITEM_DIRECTIONS = ['ALLOWANCE', 'DEDUCTION'] as const;
export type PayItemDirection = (typeof PAY_ITEM_DIRECTIONS)[number];

export const PAY_ITEM_CALCULATIONS = ['FIXED', 'PERCENT_OF_GROSS'] as const;
export type PayItemCalculation = (typeof PAY_ITEM_CALCULATIONS)[number];

/** ₱100,000.00 per hour: far above any real rate, low enough to keep integer maths exact. */
export const MAX_HOURLY_RATE_CENTAVOS = 10_000_000;
/** ₱1,000,000.00 per payroll for a single allowance or deduction. */
export const MAX_ITEM_CENTAVOS = 100_000_000;

const centavos = (max: number) => z.number().int().min(0).max(max);
const note = z.string().trim().max(500).optional();

// ── Undertime policies ───────────────────────────────────────────────────────

export const undertimeTierSchema = z.object({
  upToMinutes: z.number().int().min(1).max(480),
  amountCentavos: centavos(MAX_ITEM_CENTAVOS),
});
export type UndertimeTier = z.infer<typeof undertimeTierSchema>;

export const undertimePolicySchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    kind: z.enum(UNDERTIME_POLICY_KINDS),
    blockMinutes: z.number().int().min(1).max(480).nullable().default(null),
    amountPerBlockCentavos: centavos(MAX_ITEM_CENTAVOS).nullable().default(null),
    chargePartialBlock: z.boolean().default(true),
    tiers: z.array(undertimeTierSchema).max(10).nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((p, ctx) => {
    if (p.kind === 'FIXED_PER_BLOCK') {
      if (p.blockMinutes === null)
        ctx.addIssue({ code: 'custom', path: ['blockMinutes'], message: 'Enter the block length' });
      if (p.amountPerBlockCentavos === null)
        ctx.addIssue({
          code: 'custom',
          path: ['amountPerBlockCentavos'],
          message: 'Enter the amount per block',
        });
    }
    if (p.kind === 'TIERED') {
      if (!p.tiers?.length) {
        ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'Add at least one tier' });
        return;
      }
      p.tiers.forEach((t, i) => {
        const prev = p.tiers![i - 1];
        if (prev && t.upToMinutes <= prev.upToMinutes)
          ctx.addIssue({
            code: 'custom',
            path: ['tiers', i, 'upToMinutes'],
            message: 'Each tier must cover more minutes than the one before',
          });
        if (prev && t.amountCentavos < prev.amountCentavos)
          ctx.addIssue({
            code: 'custom',
            path: ['tiers', i, 'amountCentavos'],
            message: 'A longer tier cannot cost less',
          });
      });
    }
  })
  .transform((p) => ({
    ...p,
    blockMinutes: p.kind === 'FIXED_PER_BLOCK' ? p.blockMinutes : null,
    amountPerBlockCentavos: p.kind === 'FIXED_PER_BLOCK' ? p.amountPerBlockCentavos : null,
    chargePartialBlock: p.kind === 'FIXED_PER_BLOCK' ? p.chargePartialBlock : true,
    tiers: p.kind === 'TIERED' ? p.tiers : null,
  }));
export type UndertimePolicyInput = z.infer<typeof undertimePolicySchema>;

export interface UndertimePolicyView {
  id: string;
  name: string;
  kind: UndertimePolicyKind;
  blockMinutes: number | null;
  amountPerBlockCentavos: number | null;
  chargePartialBlock: boolean;
  tiers: UndertimeTier[] | null;
  isDefault: boolean;
  isActive: boolean;
}

// ── Compensation profiles ────────────────────────────────────────────────────

export const compensationProfileSchema = z
  .object({
    effectiveFrom: isoDateSchema,
    hourlyRateCentavos: z.number().int().min(1).max(MAX_HOURLY_RATE_CENTAVOS),
    overtimeRateKind: z.enum(OVERTIME_RATE_KINDS),
    overtimeMultiplierPermille: z.number().int().min(1000).max(5000).nullable().default(null),
    overtimeFixedRateCentavos: z
      .number()
      .int()
      .min(1)
      .max(MAX_HOURLY_RATE_CENTAVOS)
      .nullable()
      .default(null),
    undertimePolicyId: uuidSchema,
    paySchedule: z.enum(PAY_SCHEDULES),
    note,
  })
  .superRefine((p, ctx) => {
    if (p.overtimeRateKind === 'MULTIPLIER' && p.overtimeMultiplierPermille === null)
      ctx.addIssue({
        code: 'custom',
        path: ['overtimeMultiplierPermille'],
        message: 'Enter the overtime multiplier',
      });
    if (p.overtimeRateKind === 'FIXED' && p.overtimeFixedRateCentavos === null)
      ctx.addIssue({
        code: 'custom',
        path: ['overtimeFixedRateCentavos'],
        message: 'Enter the overtime hourly rate',
      });
  })
  .transform((p) => ({
    ...p,
    overtimeMultiplierPermille:
      p.overtimeRateKind === 'MULTIPLIER' ? p.overtimeMultiplierPermille : null,
    overtimeFixedRateCentavos: p.overtimeRateKind === 'FIXED' ? p.overtimeFixedRateCentavos : null,
  }));
export type CompensationProfileInput = z.infer<typeof compensationProfileSchema>;

export interface CompensationProfileView {
  id: string;
  effectiveFrom: string;
  hourlyRateCentavos: number;
  overtimeRateKind: OvertimeRateKind;
  overtimeMultiplierPermille: number | null;
  overtimeFixedRateCentavos: number | null;
  undertimePolicy: { id: string; name: string };
  paySchedule: PaySchedule;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  /** True for the version in force today. */
  isCurrent: boolean;
  /** Only versions that have not started yet can be removed. */
  canRemove: boolean;
}

// ── Allowances and deductions ────────────────────────────────────────────────

export const payItemTypeSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{0,19}$/, 'Use 1–20 letters, digits or underscores'),
  name: z.string().trim().min(2).max(100),
  direction: z.enum(PAY_ITEM_DIRECTIONS),
  isActive: z.boolean().default(true),
});
export type PayItemTypeInput = z.infer<typeof payItemTypeSchema>;

export interface PayItemTypeView {
  id: string;
  code: string;
  name: string;
  direction: PayItemDirection;
  isActive: boolean;
}

export const employeePayItemSchema = z
  .object({
    typeId: uuidSchema,
    calculation: z.enum(PAY_ITEM_CALCULATIONS),
    amountCentavos: z.number().int().min(1).max(MAX_ITEM_CENTAVOS).nullable().default(null),
    rateBasisPoints: z.number().int().min(1).max(10_000).nullable().default(null),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullable().default(null),
    note,
  })
  .superRefine((p, ctx) => {
    if (p.calculation === 'FIXED' && p.amountCentavos === null)
      ctx.addIssue({ code: 'custom', path: ['amountCentavos'], message: 'Enter the amount' });
    if (p.calculation === 'PERCENT_OF_GROSS' && p.rateBasisPoints === null)
      ctx.addIssue({ code: 'custom', path: ['rateBasisPoints'], message: 'Enter the percentage' });
    if (p.effectiveTo && p.effectiveTo < p.effectiveFrom)
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveTo'],
        message: 'End date must be on or after the start date',
      });
  })
  .transform((p) => ({
    ...p,
    amountCentavos: p.calculation === 'FIXED' ? p.amountCentavos : null,
    rateBasisPoints: p.calculation === 'PERCENT_OF_GROSS' ? p.rateBasisPoints : null,
  }));
export type EmployeePayItemInput = z.infer<typeof employeePayItemSchema>;

export const endPayItemSchema = z.object({
  effectiveTo: isoDateSchema,
  version: z.number().int().min(1),
});
export type EndPayItemInput = z.infer<typeof endPayItemSchema>;

export interface EmployeePayItemView {
  id: string;
  version: number;
  type: PayItemTypeView;
  calculation: PayItemCalculation;
  amountCentavos: number | null;
  rateBasisPoints: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  createdBy: string | null;
  /** In force today. */
  isActive: boolean;
  /** Not started yet, so it can be removed outright instead of ended. */
  canRemove: boolean;
}

export interface CompensationOverview {
  employee: {
    id: string;
    accountNumber: string;
    fullName: string;
    department: string | null;
    position: string | null;
    classification: string;
  };
  profiles: CompensationProfileView[];
  items: EmployeePayItemView[];
}

export const compensationListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  departmentId: uuidSchema.optional(),
  /** Only employees without a pay profile in force today. */
  missing: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type CompensationListQuery = z.infer<typeof compensationListQuerySchema>;

export interface CompensationListRow {
  employee: { id: string; accountNumber: string; fullName: string; department: string | null };
  current: {
    hourlyRateCentavos: number;
    paySchedule: PaySchedule;
    effectiveFrom: string;
  } | null;
  activeItems: number;
}

// ── Calculation preview ──────────────────────────────────────────────────────

/** Longest period a single calculation covers (a month plus slack for custom ranges). */
export const MAX_PAY_PERIOD_DAYS = 31;

export const payrollPreviewQuerySchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .superRefine((v, ctx) => {
    if (v.from > v.to)
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'End date must be on or after start' });
    else if ((Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 >= MAX_PAY_PERIOD_DAYS)
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: `A pay period covers at most ${MAX_PAY_PERIOD_DAYS} days`,
      });
  });
export type PayrollPreviewQuery = z.infer<typeof payrollPreviewQuerySchema>;

export const PAY_LINE_KINDS = [
  'REGULAR',
  'PAID_LEAVE',
  'OVERTIME',
  'UNDERTIME',
  'ALLOWANCE',
  'DEDUCTION',
] as const;
export type PayLineKind = (typeof PAY_LINE_KINDS)[number];

export interface PayLine {
  kind: PayLineKind;
  label: string;
  /** Minutes for time-based lines. */
  minutes: number | null;
  /** Positive for earnings, negative for deductions. */
  amountCentavos: number;
  /** How it was worked out, for HR verification (spec §3.4 "complete breakdown"). */
  detail: string;
}

export const PAY_WARNING_CODES = [
  'NO_PROFILE',
  'INCOMPLETE_DAY',
  'PENDING_OVERTIME',
  'NEGATIVE_NET',
] as const;
export type PayWarningCode = (typeof PAY_WARNING_CODES)[number];

export interface PayWarning {
  code: PayWarningCode;
  date: string | null;
  message: string;
}

export interface PayrollCalculation {
  from: string;
  to: string;
  lines: PayLine[];
  grossCentavos: number;
  deductionsCentavos: number;
  netCentavos: number;
  warnings: PayWarning[];
}

export interface PayrollPreview extends PayrollCalculation {
  employee: { id: string; accountNumber: string; fullName: string };
}
