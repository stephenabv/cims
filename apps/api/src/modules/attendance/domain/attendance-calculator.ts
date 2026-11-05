import { instantAt } from './work-date';

export type PunchType = 'TIME_IN' | 'TIME_OUT';

export interface Punch {
  type: PunchType;
  at: Date;
}

export interface ScheduleWindow {
  startMinute: number;
  endMinute: number;
}

export interface SchedulePolicy {
  graceMinutes: number;
  breakMinutes: number;
  breakThresholdMinutes: number;
}

export interface DayContext {
  workDate: string;
  timezone: string;
  /** Null on rest days. */
  window: ScheduleWindow | null;
  policy: SchedulePolicy;
  isHoliday: boolean;
}

export type DayStatus = 'PRESENT' | 'LATE' | 'INCOMPLETE' | 'REST_DAY_WORKED' | 'HOLIDAY_WORKED';

export interface DayResult {
  firstIn: Date | null;
  lastOut: Date | null;
  workedMinutes: number;
  regularMinutes: number;
  lateMinutes: number;
  undertimeMinutes: number;
  overtimeMinutes: number;
  scheduledMinutes: number;
  hasOpenPunch: boolean;
  status: DayStatus;
}

const minutesBetween = (a: Date, b: Date) =>
  Math.max(0, Math.floor((b.getTime() - a.getTime()) / 60_000));

/**
 * Derives one day's attendance figures from its accepted punches (spec §3.1, assumption A-1).
 *
 * - Worked time = sum of closed IN→OUT pairs, minus the unpaid break once the threshold is reached.
 * - Late = minutes after scheduled start, counted only when arrival is beyond the grace period.
 * - Overtime = time after scheduled end (or all time on rest days / holidays). It is only *recorded*
 *   here; payroll pays it only after approval (BR-13).
 * - Undertime = scheduled minutes not covered by regular work, excluding minutes already counted as late
 *   and minutes excused by the grace period.
 * - A day with an unmatched time-in or stray time-out is INCOMPLETE and has no undertime/overtime
 *   until corrected.
 */
export function computeAttendanceDay(punches: readonly Punch[], ctx: DayContext): DayResult {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  let open: Date | null = null;
  let anomaly = false;
  let grossMinutes = 0;
  let firstIn: Date | null = null;
  let lastOut: Date | null = null;

  for (const p of sorted) {
    if (p.type === 'TIME_IN') {
      if (open) anomaly = true; // previous time-in never closed
      open = p.at;
      firstIn ??= p.at;
    } else if (open) {
      grossMinutes += minutesBetween(open, p.at);
      lastOut = p.at;
      open = null;
    } else {
      anomaly = true; // time-out without time-in
    }
  }
  const hasOpenPunch = open !== null;
  const incomplete = hasOpenPunch || anomaly;

  const breakDeduction =
    grossMinutes >= ctx.policy.breakThresholdMinutes
      ? Math.min(ctx.policy.breakMinutes, grossMinutes)
      : 0;
  const workedMinutes = grossMinutes - breakDeduction;

  const base = { firstIn, lastOut, workedMinutes, hasOpenPunch };

  if (!ctx.window || ctx.isHoliday) {
    return {
      ...base,
      regularMinutes: 0,
      lateMinutes: 0,
      undertimeMinutes: 0,
      overtimeMinutes: incomplete ? 0 : workedMinutes,
      scheduledMinutes: 0,
      status: incomplete ? 'INCOMPLETE' : ctx.isHoliday ? 'HOLIDAY_WORKED' : 'REST_DAY_WORKED',
    };
  }

  const start = instantAt(ctx.workDate, ctx.window.startMinute, ctx.timezone);
  const end = instantAt(ctx.workDate, ctx.window.endMinute, ctx.timezone);
  const scheduledMinutes = Math.max(
    0,
    ctx.window.endMinute - ctx.window.startMinute - ctx.policy.breakMinutes,
  );

  const graceEnd = start.getTime() + ctx.policy.graceMinutes * 60_000;
  const lateMinutes =
    firstIn && firstIn.getTime() > graceEnd
      ? Math.min(scheduledMinutes, minutesBetween(start, firstIn))
      : 0;
  // Arriving inside the grace period is excused: those minutes are neither late nor undertime.
  const excusedMinutes =
    firstIn && lateMinutes === 0 && firstIn > start ? minutesBetween(start, firstIn) : 0;

  if (incomplete) {
    return {
      ...base,
      regularMinutes: Math.min(workedMinutes, scheduledMinutes),
      lateMinutes,
      undertimeMinutes: 0,
      overtimeMinutes: 0,
      scheduledMinutes,
      status: 'INCOMPLETE',
    };
  }

  const overtimeMinutes =
    lastOut && lastOut > end ? Math.min(workedMinutes, minutesBetween(end, lastOut)) : 0;
  const regularMinutes = Math.min(scheduledMinutes, Math.max(0, workedMinutes - overtimeMinutes));
  const undertimeMinutes = Math.max(
    0,
    scheduledMinutes - regularMinutes - lateMinutes - excusedMinutes,
  );

  return {
    ...base,
    regularMinutes,
    lateMinutes,
    undertimeMinutes,
    overtimeMinutes,
    scheduledMinutes,
    status: lateMinutes > 0 ? 'LATE' : 'PRESENT',
  };
}
