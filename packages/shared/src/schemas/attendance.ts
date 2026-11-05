import { z } from 'zod';
import { accountNumberSchema } from './auth';
import { isoDateSchema, paginationSchema, uuidSchema } from './common';

export const PUNCH_TYPES = ['TIME_IN', 'TIME_OUT'] as const;
export type PunchType = (typeof PUNCH_TYPES)[number];

/** Kiosk punch. The PIN is format-checked only; weak-PIN rules apply when PINs are set, not used. */
export const kioskPunchSchema = z.object({
  accountNumber: accountNumberSchema,
  pin: z.string().regex(/^\d{6}$/, 'PIN must be 6 digits'),
  type: z.enum(PUNCH_TYPES),
});
export type KioskPunchInput = z.infer<typeof kioskPunchSchema>;

export interface KioskPunchResult {
  type: PunchType;
  occurredAt: string;
  workDate: string;
  /** First name and last initial only: enough to confirm identity on a shared screen. */
  displayName: string;
}

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
  punches: { id: string; type: PunchType; occurredAt: string; source: string; status: string }[];
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
