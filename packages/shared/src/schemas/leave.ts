import { z } from 'zod';
import { isoDateSchema, paginationSchema, uuidSchema } from './common';

/** Spec §3.3; CANCELLED vs WITHDRAWN per assumption A-4. */
export const LEAVE_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'WITHDRAWN',
] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const APPROVAL_STEP_KINDS = ['SUPERVISOR', 'DEPARTMENT_HEAD', 'ROLE', 'EMPLOYEE'] as const;
export type ApprovalStepKind = (typeof APPROVAL_STEP_KINDS)[number];

export type LeaveStepStatus =
  | 'WAITING'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'SKIPPED'
  | 'CANCELLED';

/** Longest single request, in calendar days (long enough for statutory maternity leave). */
export const MAX_LEAVE_SPAN_DAYS = 120;

const reason = (min: number, max: number, msg: string) => z.string().trim().min(min, msg).max(max);

// ── Configuration ─────────────────────────────────────────────────────────────

export const leaveTypeSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{0,19}$/, 'Use 1–20 letters, digits or underscores'),
  name: z.string().trim().min(2).max(100),
  isPaid: z.boolean(),
  isActive: z.boolean().default(true),
  /** Null = the company default approval chain. */
  approvalChainId: uuidSchema.nullable().default(null),
});
export type LeaveTypeInput = z.infer<typeof leaveTypeSchema>;

export const approvalChainStepSchema = z
  .object({
    kind: z.enum(APPROVAL_STEP_KINDS),
    roleId: uuidSchema.nullable().default(null),
    employeeId: uuidSchema.nullable().default(null),
  })
  .superRefine((s, ctx) => {
    if (s.kind === 'ROLE' && !s.roleId)
      ctx.addIssue({ code: 'custom', path: ['roleId'], message: 'Choose a role' });
    if (s.kind === 'EMPLOYEE' && !s.employeeId)
      ctx.addIssue({ code: 'custom', path: ['employeeId'], message: 'Choose an employee' });
  })
  .transform((s) => ({
    kind: s.kind,
    roleId: s.kind === 'ROLE' ? s.roleId : null,
    employeeId: s.kind === 'EMPLOYEE' ? s.employeeId : null,
  }));
export type ApprovalChainStepInput = z.infer<typeof approvalChainStepSchema>;

export const approvalChainSchema = z.object({
  name: z.string().trim().min(2).max(100),
  steps: z.array(approvalChainStepSchema).min(1, 'Add at least one approver').max(5),
});
export type ApprovalChainInput = z.infer<typeof approvalChainSchema>;

export const leaveBalanceSchema = z.object({
  employeeId: uuidSchema,
  leaveTypeId: uuidSchema,
  year: z.number().int().min(2000).max(2100),
  /** Null removes the limit for that type and year. */
  allottedDays: z.number().int().min(0).max(366).nullable(),
});
export type LeaveBalanceInput = z.infer<typeof leaveBalanceSchema>;

export interface LeaveTypeView {
  id: string;
  code: string;
  name: string;
  isPaid: boolean;
  isActive: boolean;
  approvalChainId: string | null;
}

export interface ApprovalChainView {
  id: string;
  name: string;
  isDefault: boolean;
  steps: {
    kind: ApprovalStepKind;
    roleId: string | null;
    roleName: string | null;
    employeeId: string | null;
    employeeName: string | null;
  }[];
}

export interface LeaveBalanceView {
  leaveType: { id: string; code: string; name: string; isPaid: boolean };
  year: number;
  /** Null when no limit is configured for this type and year. */
  allottedDays: number | null;
  approvedDays: number;
  pendingDays: number;
  remainingDays: number | null;
}

// ── Requests ──────────────────────────────────────────────────────────────────

const dateSpan = z
  .object({ leaveTypeId: uuidSchema, startDate: isoDateSchema, endDate: isoDateSchema })
  .refine((v) => v.startDate <= v.endDate, {
    path: ['endDate'],
    message: 'End date must be on or after the start date',
  })
  .refine(
    (v) => (Date.parse(v.endDate) - Date.parse(v.startDate)) / 86_400_000 < MAX_LEAVE_SPAN_DAYS,
    {
      path: ['endDate'],
      message: `A single request can cover at most ${MAX_LEAVE_SPAN_DAYS} days`,
    },
  );

export const leavePreviewSchema = dateSpan;
export type LeavePreviewInput = z.infer<typeof leavePreviewSchema>;

export const applyLeaveSchema = dateSpan.and(
  z.object({ reason: reason(3, 1000, 'Give a reason') }),
);
export type ApplyLeaveInput = z.infer<typeof applyLeaveSchema>;

/** `version` makes concurrent actions on the same request fail instead of overwriting (409). */
export const leaveDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().max(500).optional(),
    version: z.number().int().min(1),
  })
  .refine((v) => v.decision === 'APPROVE' || (v.note?.length ?? 0) >= 3, {
    path: ['note'],
    message: 'Explain why the request is rejected',
  });
export type LeaveDecisionInput = z.infer<typeof leaveDecisionSchema>;

export const withdrawLeaveSchema = z.object({ version: z.number().int().min(1) });
export type WithdrawLeaveInput = z.infer<typeof withdrawLeaveSchema>;

export const cancelLeaveSchema = z.object({
  version: z.number().int().min(1),
  reason: reason(3, 500, 'Give a reason'),
});
export type CancelLeaveInput = z.infer<typeof cancelLeaveSchema>;

export const leaveRequestQuerySchema = paginationSchema.extend({
  status: z.enum(LEAVE_STATUSES).optional(),
  employeeId: uuidSchema.optional(),
  /** Requests overlapping this window. */
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type LeaveRequestQuery = z.infer<typeof leaveRequestQuerySchema>;

export const myLeaveQuerySchema = paginationSchema.extend({
  status: z.enum(LEAVE_STATUSES).optional(),
});
export type MyLeaveQuery = z.infer<typeof myLeaveQuerySchema>;

export interface LeavePreview {
  days: number;
  /** Working dates counted (rest days and holidays excluded). */
  dates: string[];
}

export interface LeaveRequestView {
  id: string;
  version: number;
  status: LeaveStatus;
  employee: { id: string; accountNumber: string; fullName: string };
  leaveType: { id: string; code: string; name: string; isPaid: boolean };
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  submittedAt: string;
  decidedAt: string | null;
  endReason: string | null;
  steps: {
    position: number;
    kind: ApprovalStepKind;
    /** Who may act: a person's name or a role's name. */
    approver: string | null;
    status: LeaveStepStatus;
    actedBy: string | null;
    actedAt: string | null;
    note: string | null;
  }[];
  /** What the viewer may do now (the API enforces the same rules). */
  can: { decide: boolean; withdraw: boolean; cancel: boolean };
}
