import { z } from 'zod';
import { type PunchType } from './attendance';
import { isoDateSchema, paginationSchema, uuidSchema } from './common';

/** Attendance correction requests filed by employees (attendance spec §2). */

export const CORRECTION_TYPES = [
  'CHANGE_TIME_IN',
  'CHANGE_TIME_OUT',
  'MISSING_TIME_IN',
  'MISSING_TIME_OUT',
  'INCORRECT_TIMESTAMP',
  'OTHER',
] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];

export const CORRECTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

/** Types that change an existing punch and therefore need one selected. */
export const CORRECTION_NEEDS_TARGET: readonly CorrectionType[] = [
  'CHANGE_TIME_IN',
  'CHANGE_TIME_OUT',
  'INCORRECT_TIMESTAMP',
];
/** Types that write a punch and therefore need the correct date and time. */
export const CORRECTION_NEEDS_TIME: readonly CorrectionType[] = [
  'CHANGE_TIME_IN',
  'CHANGE_TIME_OUT',
  'MISSING_TIME_IN',
  'MISSING_TIME_OUT',
  'INCORRECT_TIMESTAMP',
];

export const CORRECTION_REASON_MIN = 10;

const time24 = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

/**
 * `requestedDate` + `requestedTime` are the correct wall-clock time in the company timezone. For a
 * time-out after midnight, use the calendar date it happened on; `workDate` stays the shift's date.
 */
export const submitCorrectionSchema = z
  .object({
    workDate: isoDateSchema,
    type: z.enum(CORRECTION_TYPES),
    targetEventId: uuidSchema.optional(),
    requestedDate: isoDateSchema.optional(),
    requestedTime: time24.optional(),
    reason: z
      .string()
      .trim()
      .min(
        CORRECTION_REASON_MIN,
        `Explain the correction (at least ${CORRECTION_REASON_MIN} characters)`,
      )
      .max(1000),
  })
  .superRefine((v, ctx) => {
    if (CORRECTION_NEEDS_TARGET.includes(v.type) && !v.targetEventId)
      ctx.addIssue({
        code: 'custom',
        path: ['targetEventId'],
        message: 'Choose the punch to correct',
      });
    if (CORRECTION_NEEDS_TIME.includes(v.type)) {
      if (!v.requestedDate)
        ctx.addIssue({
          code: 'custom',
          path: ['requestedDate'],
          message: 'Enter the correct date',
        });
      if (!v.requestedTime)
        ctx.addIssue({
          code: 'custom',
          path: ['requestedTime'],
          message: 'Enter the correct time',
        });
    }
  });
export type SubmitCorrectionInput = z.infer<typeof submitCorrectionSchema>;

export const correctionDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().max(500).optional(),
    version: z.number().int().min(1),
  })
  .refine((v) => v.decision === 'APPROVE' || (v.note?.length ?? 0) >= 3, {
    path: ['note'],
    message: 'Explain why the request is rejected',
  });
export type CorrectionDecisionInput = z.infer<typeof correctionDecisionSchema>;

export const cancelCorrectionSchema = z.object({ version: z.number().int().min(1) });
export type CancelCorrectionInput = z.infer<typeof cancelCorrectionSchema>;

export const myCorrectionsQuerySchema = paginationSchema.extend({
  status: z.enum(CORRECTION_STATUSES).optional(),
});
export type MyCorrectionsQuery = z.infer<typeof myCorrectionsQuerySchema>;

export const correctionSettingsSchema = z.object({ approvalChainId: uuidSchema.nullable() });
export type CorrectionSettingsInput = z.infer<typeof correctionSettingsSchema>;

export interface CorrectionPunchView {
  id: string;
  type: PunchType;
  occurredAt: string;
  status: string;
  source: string;
}

export interface CorrectionRequestView {
  id: string;
  version: number;
  status: CorrectionStatus;
  type: CorrectionType;
  punchType: PunchType | null;
  employee: { id: string; accountNumber: string; fullName: string };
  workDate: string;
  /** Company timezone the instants should be shown in. */
  timezone: string;
  /** Value of the targeted punch when the request was filed. */
  originalAt: string | null;
  requestedAt: string | null;
  /** Final value written to the official record (approved requests that change a punch). */
  appliedAt: string | null;
  reason: string;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  /** The record as it stands now, for side-by-side review. */
  currentPunches: CorrectionPunchView[];
  steps: {
    position: number;
    kind: string;
    approver: string | null;
    status: string;
    actedBy: string | null;
    actedAt: string | null;
    note: string | null;
  }[];
  can: { decide: boolean; cancel: boolean };
}
