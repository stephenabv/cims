import { z } from 'zod';
import { isoDateSchema, paginationSchema, uuidSchema } from './common';

/**
 * Overtime records (spec §3.4 "Overtime Management", §3.6, BR-13).
 *
 * A record is created from a completed attendance day whose overtime reaches the company minimum.
 * VOIDED: the day's overtime disappeared (e.g. HR corrected the punches) after a decision was made;
 * the record is kept so the decision history stays visible.
 */
export const OVERTIME_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'VOIDED'] as const;
export type OvertimeStatus = (typeof OVERTIME_STATUSES)[number];

export const OVERTIME_ACTIONS = ['APPROVE', 'REJECT', 'REOPEN', 'VOID'] as const;
export type OvertimeAction = (typeof OVERTIME_ACTIONS)[number];

/** Upper bound for the policy minimums (4 hours). */
const POLICY_MAX_MINUTES = 240;

export const overtimePolicySchema = z.object({
  /** Overtime shorter than this on a day does not create a record. */
  overtimeMinimumMinutes: z.number().int().min(0).max(POLICY_MAX_MINUTES),
  /** Daily undertime shorter than this is shown but not counted toward deductions. */
  undertimeThresholdMinutes: z.number().int().min(0).max(POLICY_MAX_MINUTES),
});
export type OvertimePolicy = z.infer<typeof overtimePolicySchema>;

/** `version` makes concurrent decisions on the same record fail instead of overwriting (409). */
export const overtimeDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    /** Approve fewer minutes than worked (partial approval). Defaults to all minutes. */
    approvedMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
    note: z.string().trim().max(500).optional(),
    version: z.number().int().min(1),
  })
  .refine((v) => v.decision === 'APPROVE' || (v.note?.length ?? 0) >= 3, {
    path: ['note'],
    message: 'Explain why the overtime is rejected',
  })
  .refine((v) => v.decision === 'APPROVE' || v.approvedMinutes === undefined, {
    path: ['approvedMinutes'],
    message: 'Only an approval has approved minutes',
  });
export type OvertimeDecisionInput = z.infer<typeof overtimeDecisionSchema>;

const MAX_RANGE_DAYS = 93;
const dateRange = paginationSchema.extend({ from: isoDateSchema, to: isoDateSchema });
const checkRange = (v: { from: string; to: string }, ctx: z.RefinementCtx) => {
  if (v.from > v.to)
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'End date must be on or after start' });
  else if ((Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 >= MAX_RANGE_DAYS)
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: `Choose a range of at most ${MAX_RANGE_DAYS} days`,
    });
};

/** Approver/HR list. Without dates it covers every work date (e.g. everything still pending). */
export const overtimeQuerySchema = paginationSchema
  .extend({
    status: z.enum(OVERTIME_STATUSES).optional(),
    departmentId: uuidSchema.optional(),
    employeeId: uuidSchema.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    path: ['to'],
    message: 'End date must be on or after start',
  });
export type OvertimeQuery = z.infer<typeof overtimeQuerySchema>;

export const myOvertimeQuerySchema = dateRange.superRefine(checkRange);
export type MyOvertimeQuery = z.infer<typeof myOvertimeQuerySchema>;

export const overtimeSummaryQuerySchema = dateRange
  .extend({ departmentId: uuidSchema.optional() })
  .superRefine(checkRange);
export type OvertimeSummaryQuery = z.infer<typeof overtimeSummaryQuerySchema>;

export interface OvertimeRecordView {
  id: string;
  version: number;
  status: OvertimeStatus;
  employee: { id: string; accountNumber: string; fullName: string; department: string | null };
  workDate: string;
  firstIn: string | null;
  lastOut: string | null;
  /** Overtime worked according to attendance. */
  actualMinutes: number;
  /** Payable minutes; set only while APPROVED. */
  approvedMinutes: number | null;
  history: {
    action: OvertimeAction;
    minutes: number | null;
    note: string | null;
    /** Null for changes the system made when attendance was recomputed. */
    actedBy: string | null;
    actedAt: string;
  }[];
  can: { decide: boolean };
}

export interface OvertimeSummaryRow {
  employee: { id: string; accountNumber: string; fullName: string; department: string | null };
  daysWorked: number;
  overtime: {
    approvedMinutes: number;
    pendingMinutes: number;
    rejectedMinutes: number;
    /** Overtime below the company minimum that never became a record. */
    unrecordedMinutes: number;
  };
  undertime: {
    days: number;
    totalMinutes: number;
    /** Minutes on days at or above the threshold: the basis for payroll deductions. */
    countedMinutes: number;
  };
  lateMinutes: number;
}

export interface OvertimeSummaryTotals {
  approvedMinutes: number;
  pendingMinutes: number;
  undertimeCountedMinutes: number;
  lateMinutes: number;
}

export interface OvertimeSummaryResult {
  data: OvertimeSummaryRow[];
  meta: { page: number; pageSize: number; total: number };
  totals: OvertimeSummaryTotals;
  policy: OvertimePolicy;
}
