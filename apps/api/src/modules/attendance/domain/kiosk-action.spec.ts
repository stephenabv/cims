import {
  type KioskActionFacts,
  type ShiftWindow,
  type TimelinePunch,
  decideKioskAction,
  shiftWorkDate,
} from './kiosk-action';
import { workDateOf } from './work-date';

const TZ = 'Asia/Manila';
const at = (date: string, time: string) => new Date(`${date}T${time}:00+08:00`);
const DAY: ShiftWindow = { startMinute: 8 * 60, endMinute: 17 * 60 };
const NIGHT: ShiftWindow = { startMinute: 22 * 60, endMinute: 30 * 60 }; // 22:00–06:00 next day
const policy = {
  duplicateWindowMs: 60_000,
  maxShiftMs: 18 * 3_600_000,
  shiftMarginMs: 4 * 3_600_000,
};

/** Weekdays (2026-11-02 Mon … 2026-11-06 Fri) use `w`; weekends are rest days. */
const weekdays = (w: ShiftWindow) => (d: string) => {
  const day = new Date(`${d}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6 ? null : w;
};

function decide(now: Date, punches: TimelinePunch[], windowFor = weekdays(DAY)) {
  const before = punches.filter((p) => p.at <= now);
  const facts: KioskActionFacts = {
    now,
    timezone: TZ,
    last: before.at(-1) ?? null,
    windowFor,
    punchesOn: (d) => before.filter((p) => p.workDate === d),
    policy,
  };
  return decideKioskAction(facts, workDateOf(now, TZ));
}

const p = (type: TimelinePunch['type'], date: string, time: string, workDate = date) => ({
  type,
  at: at(date, time),
  workDate,
});

describe('decideKioskAction', () => {
  it('offers a time in when there is no record for the shift', () => {
    expect(decide(at('2026-11-04', '07:55'), [])).toEqual({
      kind: 'TIME_IN',
      workDate: '2026-11-04',
    });
  });

  it('offers a time out when the shift has an open time in', () => {
    const d = decide(at('2026-11-04', '17:02'), [p('TIME_IN', '2026-11-04', '07:55')]);
    expect(d).toMatchObject({ kind: 'TIME_OUT', workDate: '2026-11-04' });
  });

  it('reports a completed shift instead of opening a second session', () => {
    const punches = [p('TIME_IN', '2026-11-04', '07:55'), p('TIME_OUT', '2026-11-04', '17:02')];
    expect(decide(at('2026-11-04', '17:30'), punches)).toMatchObject({ kind: 'COMPLETED' });
    // Late evening, beyond the margin: the shift of the same calendar day is still complete.
    expect(decide(at('2026-11-04', '23:00'), punches)).toMatchObject({
      kind: 'COMPLETED',
      workDate: '2026-11-04',
    });
    // Next morning is a new shift.
    expect(decide(at('2026-11-05', '07:50'), punches)).toEqual({
      kind: 'TIME_IN',
      workDate: '2026-11-05',
    });
  });

  it('treats an immediate second press as already recorded', () => {
    const now = new Date(at('2026-11-04', '07:55').getTime() + 30_000);
    const d = decide(now, [p('TIME_IN', '2026-11-04', '07:55')]);
    expect(d).toMatchObject({ kind: 'JUST_RECORDED', type: 'TIME_IN' });
  });

  it('abandons a time in older than the maximum shift and starts a new shift', () => {
    const d = decide(at('2026-11-05', '08:00'), [p('TIME_IN', '2026-11-04', '08:00')]);
    expect(d).toEqual({ kind: 'TIME_IN', workDate: '2026-11-05' });
  });

  describe('overnight shift 22:00–06:00', () => {
    const night = weekdays(NIGHT);
    it('closes the shift after midnight on the work date it started', () => {
      const punches = [p('TIME_IN', '2026-11-04', '21:50')];
      expect(decide(at('2026-11-05', '06:05'), punches, night)).toMatchObject({
        kind: 'TIME_OUT',
        workDate: '2026-11-04',
      });
    });
    it('puts a late arrival after midnight on the previous evening’s shift', () => {
      expect(decide(at('2026-11-05', '00:30'), [], night)).toEqual({
        kind: 'TIME_IN',
        workDate: '2026-11-04',
      });
    });
    it('does not open a new shift when pressed again after the morning time out', () => {
      const punches = [
        p('TIME_IN', '2026-11-04', '21:50'),
        p('TIME_OUT', '2026-11-05', '06:05', '2026-11-04'),
      ];
      expect(decide(at('2026-11-05', '06:20'), punches, night)).toMatchObject({
        kind: 'COMPLETED',
        workDate: '2026-11-04',
      });
      expect(decide(at('2026-11-05', '21:45'), punches, night)).toEqual({
        kind: 'TIME_IN',
        workDate: '2026-11-05',
      });
    });
  });

  it('uses the calendar date on rest days', () => {
    expect(decide(at('2026-11-07', '09:00'), [])).toEqual({
      kind: 'TIME_IN',
      workDate: '2026-11-07',
    });
  });
});

describe('shiftWorkDate', () => {
  it('prefers the closest shift window and falls back to the calendar date', () => {
    const w = weekdays(NIGHT);
    expect(
      shiftWorkDate(at('2026-11-05', '02:00'), '2026-11-05', TZ, w, policy.shiftMarginMs),
    ).toBe('2026-11-04');
    expect(
      shiftWorkDate(at('2026-11-05', '19:00'), '2026-11-05', TZ, w, policy.shiftMarginMs),
    ).toBe('2026-11-05');
    expect(
      shiftWorkDate(at('2026-11-05', '13:00'), '2026-11-05', TZ, w, policy.shiftMarginMs),
    ).toBe('2026-11-05');
  });
});
