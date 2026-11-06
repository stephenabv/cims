import { assessOfflinePunch, type OfflinePolicy, type TimelinePunch } from './offline-punch';

const policy: OfflinePolicy = {
  duplicateWindowMs: 60_000,
  maxShiftMs: 18 * 3_600_000,
  maxClockSkewMs: 2 * 60_000,
  maxOfflineAgeMs: 72 * 3_600_000,
};
const t = (hhmm: string, day = '2026-11-04') => new Date(`${day}T${hhmm}:00+08:00`);
const p = (type: TimelinePunch['type'], hhmm: string, day?: string): TimelinePunch => ({
  type,
  at: t(hhmm, day),
});
const now = t('18:00');

describe('assessOfflinePunch', () => {
  it('applies a time-in with no open shift and a matching time-out', () => {
    expect(
      assessOfflinePunch(
        p('TIME_IN', '08:00'),
        p('TIME_OUT', '17:00', '2026-11-03'),
        null,
        now,
        policy,
      ),
    ).toEqual({ kind: 'APPLY' });
    expect(
      assessOfflinePunch(p('TIME_OUT', '17:00'), p('TIME_IN', '08:00'), null, now, policy),
    ).toEqual({ kind: 'APPLY' });
    expect(
      assessOfflinePunch(p('TIME_IN', '08:00'), null, p('TIME_IN', '13:00'), now, policy),
    ).toEqual({ kind: 'APPLY' });
  });

  it('rejects timestamps from the future beyond the allowed clock skew', () => {
    expect(assessOfflinePunch(p('TIME_IN', '18:01'), null, null, now, policy)).toEqual({
      kind: 'APPLY',
    });
    expect(assessOfflinePunch(p('TIME_IN', '18:05'), null, null, now, policy)).toEqual({
      kind: 'REJECT',
      reason: 'FUTURE_TIMESTAMP',
    });
  });

  it('treats the same action within the duplicate window as a duplicate', () => {
    expect(
      assessOfflinePunch(
        p('TIME_IN', '08:00'),
        { type: 'TIME_IN', at: new Date(t('08:00').getTime() - 30_000) },
        null,
        now,
        policy,
      ),
    ).toEqual({ kind: 'DUPLICATE' });
    expect(
      assessOfflinePunch(
        p('TIME_OUT', '17:00'),
        p('TIME_IN', '08:00'),
        { type: 'TIME_OUT', at: new Date(t('17:00').getTime() + 30_000) },
        now,
        policy,
      ),
    ).toEqual({ kind: 'DUPLICATE' });
  });

  it('flags contradictions for HR instead of applying them', () => {
    expect(
      assessOfflinePunch(p('TIME_IN', '09:00'), p('TIME_IN', '08:00'), null, now, policy),
    ).toEqual({ kind: 'CONFLICT', reason: 'ALREADY_TIMED_IN' });
    expect(assessOfflinePunch(p('TIME_OUT', '17:00'), null, null, now, policy)).toEqual({
      kind: 'CONFLICT',
      reason: 'NOT_TIMED_IN',
    });
    expect(
      assessOfflinePunch(p('TIME_OUT', '17:00'), p('TIME_OUT', '12:00'), null, now, policy),
    ).toEqual({ kind: 'CONFLICT', reason: 'NOT_TIMED_IN' });
    expect(
      assessOfflinePunch(
        p('TIME_OUT', '17:00'),
        p('TIME_IN', '08:00', '2026-11-03'),
        null,
        now,
        policy,
      ),
    ).toEqual({ kind: 'CONFLICT', reason: 'SHIFT_TOO_LONG' });
    expect(
      assessOfflinePunch(p('TIME_IN', '08:00'), null, p('TIME_OUT', '17:00'), now, policy),
    ).toEqual({ kind: 'CONFLICT', reason: 'OUT_OF_SEQUENCE' });
    expect(
      assessOfflinePunch(
        p('TIME_OUT', '12:00'),
        p('TIME_IN', '08:00'),
        p('TIME_OUT', '17:00'),
        now,
        policy,
      ),
    ).toEqual({ kind: 'CONFLICT', reason: 'OUT_OF_SEQUENCE' });
  });

  it('does not apply punches older than the offline limit automatically', () => {
    expect(
      assessOfflinePunch(p('TIME_IN', '08:00', '2026-11-01'), null, null, now, policy),
    ).toEqual({ kind: 'CONFLICT', reason: 'TOO_OLD' });
  });

  it('lets a stale open time-in be followed by a new time-in', () => {
    expect(
      assessOfflinePunch(
        p('TIME_IN', '08:00'),
        p('TIME_IN', '08:00', '2026-11-03'),
        null,
        now,
        policy,
      ),
    ).toEqual({ kind: 'APPLY' });
  });
});
