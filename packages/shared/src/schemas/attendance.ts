import { z } from 'zod';
import { accountNumberSchema } from './auth';
import { isoDateSchema, paginationSchema, uuidSchema } from './common';

export const PUNCH_TYPES = ['TIME_IN', 'TIME_OUT'] as const;
export type PunchType = (typeof PUNCH_TYPES)[number];

const kioskPinSchema = z.string().regex(/^\d{6}$/, 'PIN must be 6 digits');

/**
 * One-step kiosk punch (kept for kiosks still running the previous app version). `type` is
 * optional: the server decides time in or time out; when a type is sent it must match that
 * decision. The PIN is format-checked only; weak-PIN rules apply when PINs are set, not used.
 */
export const kioskPunchSchema = z.object({
  accountNumber: accountNumberSchema,
  pin: kioskPinSchema,
  type: z.enum(PUNCH_TYPES).optional(),
});
export type KioskPunchInput = z.infer<typeof kioskPunchSchema>;

export interface KioskPunchResult {
  type: PunchType;
  occurredAt: string;
  workDate: string;
  /** First name and last initial only: enough to confirm identity on a shared screen. */
  displayName: string;
}

/** Step 1 of the unified kiosk button: who is this, and what happens if they confirm? */
export const kioskIdentifySchema = z.object({
  accountNumber: accountNumberSchema,
  pin: kioskPinSchema,
});
export type KioskIdentifyInput = z.infer<typeof kioskIdentifySchema>;

/**
 * READY: confirm `action` with `confirmationToken` before `expiresAt`.
 * COMPLETED: the shift already has a time in and a time out.
 * JUST_RECORDED: the same person punched moments ago (accidental double press).
 */
export type KioskIdentifyResult =
  | {
      status: 'READY';
      displayName: string;
      action: PunchType;
      workDate: string;
      /** When the open shift started (only for TIME_OUT). */
      timeInAt: string | null;
      confirmationToken: string;
      expiresAt: string;
    }
  | {
      status: 'COMPLETED';
      displayName: string;
      workDate: string;
      timeInAt: string;
      timeOutAt: string;
    }
  | {
      status: 'JUST_RECORDED';
      displayName: string;
      workDate: string;
      type: PunchType;
      occurredAt: string;
    };

/** Step 2: record the action the server offered. Idempotent per token. */
export const kioskConfirmSchema = z.object({
  confirmationToken: z
    .string()
    .min(20)
    .max(1024)
    .regex(/^[A-Za-z0-9+/=._-]+$/),
});
export type KioskConfirmInput = z.infer<typeof kioskConfirmSchema>;

export const registerKioskSchema = z.object({ name: z.string().trim().min(2).max(100) });
export type RegisterKioskInput = z.infer<typeof registerKioskSchema>;

const dateRange = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((v) => v.from <= v.to, { message: '`from` must be on or before `to`', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 92, {
    message: 'Range is limited to 93 days',
    path: ['to'],
  });

export const myAttendanceQuerySchema = dateRange;
export type MyAttendanceQuery = z.infer<typeof myAttendanceQuerySchema>;

export const attendanceMonitorQuerySchema = paginationSchema.extend({
  date: isoDateSchema,
  departmentId: uuidSchema.optional(),
  status: z
    .enum([
      'PRESENT',
      'LATE',
      'ABSENT',
      'INCOMPLETE',
      'NOT_YET_IN',
      'REST_DAY',
      'HOLIDAY',
      'REST_DAY_WORKED',
      'HOLIDAY_WORKED',
      'ON_LEAVE',
    ])
    .optional(),
  search: z.string().trim().max(100).optional(),
});
export type AttendanceMonitorQuery = z.infer<typeof attendanceMonitorQuerySchema>;

export const employeeAttendanceQuerySchema = dateRange;

/** Daily status shown to users; ABSENT/REST_DAY/HOLIDAY/NOT_YET_IN are derived for days without punches. */
export type DailyStatus =
  | 'PRESENT'
  | 'LATE'
  | 'INCOMPLETE'
  | 'REST_DAY_WORKED'
  | 'HOLIDAY_WORKED'
  | 'ABSENT'
  | 'REST_DAY'
  | 'HOLIDAY'
  | 'NOT_YET_IN'
  | 'ON_LEAVE'
  | 'NOT_EMPLOYED';

export interface AttendanceDayView {
  workDate: string;
  status: DailyStatus;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  regularMinutes: number;
  lateMinutes: number;
  undertimeMinutes: number;
  overtimeMinutes: number;
  scheduledMinutes: number;
  punches: {
    id: string;
    type: PunchType;
    occurredAt: string;
    source: string;
    status: string;
    /** Why HR added this punch, or why it was voided. */
    note: string | null;
  }[];
}

export interface AttendanceSummary {
  daysWorked: number;
  totalWorkedMinutes: number;
  totalLateMinutes: number;
  lateCount: number;
  totalUndertimeMinutes: number;
  totalOvertimeMinutes: number;
  absences: number;
  incomplete: number;
  /** Scheduled days covered by approved leave. */
  leaveDays: number;
}

export interface AttendanceRangeResult {
  employee: { id: string; accountNumber: string; fullName: string };
  timezone: string;
  days: AttendanceDayView[];
  summary: AttendanceSummary;
}

export interface AttendanceMonitorRow {
  employee: { id: string; accountNumber: string; fullName: string; department: string | null };
  status: DailyStatus;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  lateMinutes: number;
}

export interface AttendanceMonitorResult {
  date: string;
  timezone: string;
  counts: Partial<Record<DailyStatus, number>>;
  rows: AttendanceMonitorRow[];
  meta: { page: number; pageSize: number; total: number };
}

export const scheduleSchema = z.object({
  name: z.string().trim().min(2).max(100),
  graceMinutes: z.number().int().min(0).max(240),
  breakMinutes: z.number().int().min(0).max(240),
  breakThresholdMinutes: z.number().int().min(0).max(1440),
  days: z
    .array(
      z.object({
        weekday: z.number().int().min(1).max(7),
        startMinute: z.number().int().min(0).max(1439),
        endMinute: z.number().int().min(1).max(2880),
      }),
    )
    .max(7)
    .refine(
      (d) => new Set(d.map((x) => x.weekday)).size === d.length,
      'Each weekday may appear once',
    )
    .refine((d) => d.every((x) => x.endMinute > x.startMinute), 'End must be after start'),
});
export type ScheduleInput = z.infer<typeof scheduleSchema>;

export const holidaySchema = z.object({
  date: isoDateSchema,
  name: z.string().trim().min(2).max(150),
});
export type HolidayInput = z.infer<typeof holidaySchema>;

// ─── Offline sync (§4) ───────────────────────────────────────────────────────

/**
 * What the kiosk encrypts with the server's public key for each offline punch.
 * v1: the person chose time in or time out. v2 (unified button): the server decides on sync.
 */
export const offlinePunchPayloadSchema = z.discriminatedUnion('v', [
  z.object({
    v: z.literal(1),
    clientUuid: uuidSchema,
    accountNumber: accountNumberSchema,
    pin: kioskPinSchema,
    type: z.enum(PUNCH_TYPES),
    occurredAt: z.string().datetime({ offset: true }),
  }),
  z.object({
    v: z.literal(2),
    clientUuid: uuidSchema,
    accountNumber: accountNumberSchema,
    pin: kioskPinSchema,
    occurredAt: z.string().datetime({ offset: true }),
  }),
]);
export type OfflinePunchPayload = z.infer<typeof offlinePunchPayloadSchema>;

export const MAX_SYNC_ITEMS = 200;

export const kioskSyncSchema = z.object({
  items: z
    .array(
      z.object({
        clientUuid: uuidSchema,
        keyId: uuidSchema,
        /** Base64 RSA-OAEP (SHA-256) ciphertext of an OfflinePunchPayload. */
        ciphertext: z
          .string()
          .regex(/^[A-Za-z0-9+/]+={0,2}$/)
          .max(1024),
      }),
    )
    .min(1)
    .max(MAX_SYNC_ITEMS)
    .refine(
      (items) => new Set(items.map((i) => i.clientUuid)).size === items.length,
      'Duplicate clientUuid in batch',
    ),
});
export type KioskSyncInput = z.infer<typeof kioskSyncSchema>;

/**
 * APPLIED: recorded. DUPLICATE: already recorded. CONFLICT: kept for HR review.
 * REJECTED: cannot be recorded (bad PIN, inactive account, invalid data). DEFERRED: retry later.
 * The kiosk removes every item except DEFERRED ones from its outbox.
 */
export const SYNC_ITEM_STATUSES = [
  'APPLIED',
  'DUPLICATE',
  'CONFLICT',
  'REJECTED',
  'DEFERRED',
] as const;
export type SyncItemStatus = (typeof SYNC_ITEM_STATUSES)[number];

export interface KioskSyncResult {
  results: { clientUuid: string; status: SyncItemStatus; reason?: string }[];
}

export interface KioskSyncKey {
  keyId: string;
  /** Base64 DER SubjectPublicKeyInfo for WebCrypto `importKey('spki', …, { name: 'RSA-OAEP', hash: 'SHA-256' })`. */
  publicKeySpki: string;
}

export const attendanceConflictQuerySchema = paginationSchema.extend({
  status: z.enum(['OPEN', 'ACCEPTED', 'REJECTED']).default('OPEN'),
});
export type AttendanceConflictQuery = z.infer<typeof attendanceConflictQuerySchema>;

export const resolveConflictSchema = z.object({
  decision: z.enum(['ACCEPT', 'REJECT']),
  note: z.string().trim().min(3, 'Explain the decision').max(500),
});
export type ResolveConflictInput = z.infer<typeof resolveConflictSchema>;

export interface AttendanceConflictView {
  id: string;
  status: 'OPEN' | 'ACCEPTED' | 'REJECTED';
  reason: string;
  createdAt: string;
  employee: { id: string; accountNumber: string; fullName: string };
  punch: { type: PunchType; occurredAt: string; workDate: string; device: string | null };
  resolution: { by: string | null; at: string; note: string } | null;
}

const adjustmentReason = z.string().trim().min(3, 'Give a reason').max(500);

/**
 * HR adds a missing punch (spec §4). `date` and `time` are the wall-clock time in the company
 * timezone; a time-out after midnight uses the calendar date it happened on.
 */
export const addPunchSchema = z.object({
  type: z.enum(PUNCH_TYPES),
  date: isoDateSchema,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)'),
  reason: adjustmentReason,
});
export type AddPunchInput = z.infer<typeof addPunchSchema>;

/** HR voids a wrong punch. The original stays on record, marked voided. */
export const voidPunchSchema = z.object({ reason: adjustmentReason });
export type VoidPunchInput = z.infer<typeof voidPunchSchema>;
