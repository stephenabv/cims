/**
 * Decides what to do with a punch recorded offline once it reaches the server (spec §4).
 * Pure: the caller supplies the accepted punches around the offline timestamp.
 *
 * An offline punch is applied only when it slots cleanly into the employee's existing timeline.
 * Anything that would contradict existing records is kept as a conflict for HR, never applied
 * silently and never dropped.
 */

export type PunchKind = 'TIME_IN' | 'TIME_OUT';

export interface TimelinePunch {
  type: PunchKind;
  at: Date;
}

export interface OfflinePolicy {
  /** Same-type punches closer than this are the same action recorded twice. */
  duplicateWindowMs: number;
  /** A time-in older than this cannot be closed by a time-out. */
  maxShiftMs: number;
  /** Device clocks may run ahead of the server by at most this much. */
  maxClockSkewMs: number;
  /** Punches older than this are not applied automatically. */
  maxOfflineAgeMs: number;
}

export type OfflineConflictReason =
  | 'TOO_OLD'
  | 'ALREADY_TIMED_IN'
  | 'NOT_TIMED_IN'
  | 'SHIFT_TOO_LONG'
  | 'OUT_OF_SEQUENCE'
  /** Unified button: the shift already had a time in and a time out. */
  | 'ALREADY_COMPLETED';

export type OfflineDecision =
  | { kind: 'APPLY' }
  | { kind: 'DUPLICATE' }
  | { kind: 'CONFLICT'; reason: OfflineConflictReason }
  | { kind: 'REJECT'; reason: 'FUTURE_TIMESTAMP' };

export function assessOfflinePunch(
  punch: TimelinePunch,
  /** Last accepted punch at or before `punch.at`, if any. */
  previous: TimelinePunch | null,
  /** First accepted punch after `punch.at`, if any. */
  next: TimelinePunch | null,
  now: Date,
  policy: OfflinePolicy,
): OfflineDecision {
  const at = punch.at.getTime();
  if (at > now.getTime() + policy.maxClockSkewMs)
    return { kind: 'REJECT', reason: 'FUTURE_TIMESTAMP' };

  const near = (p: TimelinePunch | null) =>
    p !== null && p.type === punch.type && Math.abs(p.at.getTime() - at) < policy.duplicateWindowMs;
  if (near(previous) || near(next)) return { kind: 'DUPLICATE' };

  if (now.getTime() - at > policy.maxOfflineAgeMs) return { kind: 'CONFLICT', reason: 'TOO_OLD' };

  const openBefore = previous?.type === 'TIME_IN' && at - previous.at.getTime() < policy.maxShiftMs;

  if (punch.type === 'TIME_IN') {
    if (openBefore) return { kind: 'CONFLICT', reason: 'ALREADY_TIMED_IN' };
    // A later time-out already closes an earlier time-in; inserting a time-in before it would
    // reassign that time-out. Leave that call to HR.
    if (next?.type === 'TIME_OUT') return { kind: 'CONFLICT', reason: 'OUT_OF_SEQUENCE' };
    return { kind: 'APPLY' };
  }

  if (!previous || previous.type === 'TIME_OUT')
    return { kind: 'CONFLICT', reason: 'NOT_TIMED_IN' };
  if (!openBefore) return { kind: 'CONFLICT', reason: 'SHIFT_TOO_LONG' };
  // The time-in was already closed by a later time-out.
  if (next?.type === 'TIME_OUT') return { kind: 'CONFLICT', reason: 'OUT_OF_SEQUENCE' };
  return { kind: 'APPLY' };
}
