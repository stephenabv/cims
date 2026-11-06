import type { DailyStatus } from '@cims/shared';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const DAILY_STATUS: Record<DailyStatus, { label: string; tone: Tone }> = {
  PRESENT: { label: 'Present', tone: 'success' },
  LATE: { label: 'Late', tone: 'warning' },
  INCOMPLETE: { label: 'Incomplete', tone: 'danger' },
  ABSENT: { label: 'Absent', tone: 'danger' },
  NOT_YET_IN: { label: 'Not yet in', tone: 'neutral' },
  REST_DAY: { label: 'Rest day', tone: 'neutral' },
  HOLIDAY: { label: 'Holiday', tone: 'info' },
  REST_DAY_WORKED: { label: 'Worked rest day', tone: 'info' },
  HOLIDAY_WORKED: { label: 'Worked holiday', tone: 'info' },
  ON_LEAVE: { label: 'On leave', tone: 'info' },
  NOT_EMPLOYED: { label: 'Not employed', tone: 'neutral' },
};

/** Order of status chips on the monitoring board. */
export const MONITOR_STATUSES = [
  'PRESENT',
  'LATE',
  'INCOMPLETE',
  'ABSENT',
  'ON_LEAVE',
  'NOT_YET_IN',
  'REST_DAY_WORKED',
  'HOLIDAY_WORKED',
  'REST_DAY',
  'HOLIDAY',
] as const satisfies readonly DailyStatus[];

export const WEEKDAYS = [
  { value: 1, short: 'Mon', label: 'Monday' },
  { value: 2, short: 'Tue', label: 'Tuesday' },
  { value: 3, short: 'Wed', label: 'Wednesday' },
  { value: 4, short: 'Thu', label: 'Thursday' },
  { value: 5, short: 'Fri', label: 'Friday' },
  { value: 6, short: 'Sat', label: 'Saturday' },
  { value: 7, short: 'Sun', label: 'Sunday' },
] as const;

/** Why an offline punch was held for review, in HR's words. */
export const CONFLICT_REASON: Record<string, string> = {
  ALREADY_TIMED_IN: 'Time-in while already timed in',
  NOT_TIMED_IN: 'Time-out without a time-in',
  SHIFT_TOO_LONG: 'Time-out too long after the time-in',
  OUT_OF_SEQUENCE: 'Out of order with existing punches',
  TOO_OLD: 'Synced too long after it was recorded',
  ALREADY_COMPLETED: 'Pressed after the shift already had a time in and out',
};

export const PUNCH_SOURCE: Record<string, string> = {
  KIOSK_ONLINE: 'Kiosk',
  KIOSK_OFFLINE: 'Kiosk (offline)',
  ADJUSTMENT: 'Added by HR',
};
