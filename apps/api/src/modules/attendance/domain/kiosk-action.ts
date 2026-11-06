/**
 * The unified kiosk button (attendance spec §1): decides whether the next punch is a time in or a
 * time out, which work date (shift) it belongs to, or that nothing should be recorded.
 *
 * Pure: callers load the facts (last punch, punches of nearby work dates, schedule windows) and
 * call this inside the same transaction that writes the punch, under the employee row lock.
 *
 * Rules
 * 1. A punch within the duplicate window of the previous one is an accidental repeat.
 * 2. An open time-in younger than the maximum shift length is closed by a TIME_OUT on its own
 *    work date. This is what makes overnight shifts work: a 06:00 time-out belongs to the
 *    22:00 time-in of the day before.
 * 3. Otherwise the punch is a TIME_IN. Its work date is the shift whose scheduled window (widened
 *    by a margin) contains the instant, closest first; with no matching window, the calendar date
 *    in the company timezone. So an employee on a 22:00–06:00 shift who arrives at 00:30 is
 *    clocked in for the shift that started the previous evening.
 * 4. A work date that already has a time in and a time out is complete: one attendance session per
 *    shift at the kiosk. A time-out a moment ago (within the margin) also counts as complete, so a
 *    second press right after leaving cannot open a new shift.
 */

import { addDays, instantAt } from './work-date';

export type PunchKind = 'TIME_IN' | 'TIME_OUT';

export interface TimelinePunch {
  type: PunchKind;
  at: Date;
  workDate: string;
}

export interface ShiftWindow {
  startMinute: number;
  endMinute: number;
}

/** Accepted punches of one work date, oldest first. */
export type SessionPunches = readonly TimelinePunch[];

export interface KioskActionPolicy {
  duplicateWindowMs: number;
  maxShiftMs: number;
  /** How far before a shift starts / after it ends a punch still belongs to it. */
  shiftMarginMs: number;
}

export interface KioskActionFacts {
  now: Date;
  timezone: string;
  /** Latest accepted punch at or before `now`, on any work date. */
  last: TimelinePunch | null;
  /** Scheduled window of a work date (null = rest day). */
  windowFor(workDate: string): ShiftWindow | null;
  /** Accepted punches of a work date, at or before `now`. Called for at most three dates. */
  punchesOn(workDate: string): SessionPunches;
  policy: KioskActionPolicy;
}

export type KioskAction =
  | { kind: 'TIME_IN'; workDate: string }
  | { kind: 'TIME_OUT'; workDate: string; timeInAt: Date }
  | { kind: 'COMPLETED'; workDate: string; timeInAt: Date; timeOutAt: Date }
  | { kind: 'JUST_RECORDED'; workDate: string; type: PunchKind; at: Date };

/** Calendar dates whose shifts could contain an instant: yesterday (overnight), today, tomorrow (early start). */
export function candidateWorkDates(calendarDate: string): string[] {
  return [addDays(calendarDate, -1), calendarDate, addDays(calendarDate, 1)];
}

/** Work date a new time-in at `at` belongs to (rule 3). */
export function shiftWorkDate(
  at: Date,
  calendarDate: string,
  timezone: string,
  windowFor: (workDate: string) => ShiftWindow | null,
  marginMs: number,
): string {
  const t = at.getTime();
  let best: { workDate: string; distance: number; calendar: boolean } | null = null;
  for (const workDate of candidateWorkDates(calendarDate)) {
    const w = windowFor(workDate);
    if (!w) continue;
    const start = instantAt(workDate, w.startMinute, timezone).getTime();
    const end = instantAt(workDate, w.endMinute, timezone).getTime();
    if (t < start - marginMs || t > end + marginMs) continue;
    const distance = t < start ? start - t : t > end ? t - end : 0;
    const calendar = workDate === calendarDate;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && calendar && !best.calendar)
    )
      best = { workDate, distance, calendar };
  }
  return best?.workDate ?? calendarDate;
}

/** A work date's session is complete once it has a time in and its latest punch is a time out. */
export function completedSession(
  punches: SessionPunches,
): { timeInAt: Date; timeOutAt: Date } | null {
  const firstIn = punches.find((p) => p.type === 'TIME_IN');
  const latest = punches.at(-1);
  if (!firstIn || !latest || latest.type !== 'TIME_OUT') return null;
  return { timeInAt: firstIn.at, timeOutAt: latest.at };
}

export function decideKioskAction(f: KioskActionFacts, calendarDate: string): KioskAction {
  const now = f.now.getTime();
  const { last, policy } = f;
  const sinceLast = last ? now - last.at.getTime() : Infinity;

  // Rule 1.
  if (last && sinceLast < policy.duplicateWindowMs)
    return { kind: 'JUST_RECORDED', workDate: last.workDate, type: last.type, at: last.at };

  // Rule 2.
  if (last?.type === 'TIME_IN' && sinceLast < policy.maxShiftMs)
    return { kind: 'TIME_OUT', workDate: last.workDate, timeInAt: last.at };

  // Rule 4, recent time-out.
  if (last?.type === 'TIME_OUT' && sinceLast < policy.shiftMarginMs) {
    const done = completedSession(f.punchesOn(last.workDate));
    if (done) return { kind: 'COMPLETED', workDate: last.workDate, ...done };
  }

  // Rule 3, then rule 4 for the chosen shift.
  const workDate = shiftWorkDate(
    f.now,
    calendarDate,
    f.timezone,
    f.windowFor,
    policy.shiftMarginMs,
  );
  const done = completedSession(f.punchesOn(workDate));
  if (done) return { kind: 'COMPLETED', workDate, ...done };
  return { kind: 'TIME_IN', workDate };
}
