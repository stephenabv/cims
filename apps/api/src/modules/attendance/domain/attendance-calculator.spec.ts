import { computeAttendanceDay, type DayContext, type Punch } from './attendance-calculator';

const TZ = 'Asia/Manila';
// Manila is UTC+8 with no DST: 08:00 local = 00:00Z.
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+08:00`);
const ctx = (over: Partial<DayContext> = {}): DayContext => ({
  workDate: '2026-11-05',
  timezone: TZ,
  window: { startMinute: 480, endMinute: 1020 },
  policy: { graceMinutes: 15, breakMinutes: 60, breakThresholdMinutes: 240 },
  isHoliday: false,
  ...over,
});
const day = (...pairs: [string, string][]): Punch[] =>
  pairs.flatMap(([i, o]) => [
    { type: 'TIME_IN' as const, at: at('2026-11-05', i) },
    ...(o ? [{ type: 'TIME_OUT' as const, at: at('2026-11-05', o) }] : []),
  ]);

describe('computeAttendanceDay', () => {
  it('computes a full on-time day', () => {
    const r = computeAttendanceDay(day(['08:00', '17:00']), ctx());
    expect(r).toMatchObject({
      workedMinutes: 480,
      regularMinutes: 480,
      lateMinutes: 0,
      undertimeMinutes: 0,
      overtimeMinutes: 0,
      scheduledMinutes: 480,
      status: 'PRESENT',
    });
  });

  it('does not mark arrivals within the grace period as late', () => {
    const r = computeAttendanceDay(day(['08:15', '17:00']), ctx());
    expect(r.lateMinutes).toBe(0);
    expect(r.status).toBe('PRESENT');
    // Minutes inside the grace period are excused, not undertime.
    expect(r.undertimeMinutes).toBe(0);
  });

  it('counts lateness from the scheduled start once beyond grace, without double-counting it as undertime', () => {
    const r = computeAttendanceDay(day(['08:30', '17:00']), ctx());
    expect(r).toMatchObject({
      lateMinutes: 30,
      undertimeMinutes: 0,
      regularMinutes: 450,
      status: 'LATE',
    });
  });

  it('records early departure as undertime', () => {
    const r = computeAttendanceDay(day(['08:00', '16:30']), ctx());
    expect(r).toMatchObject({ workedMinutes: 450, undertimeMinutes: 30, overtimeMinutes: 0 });
  });

  it('records time after the scheduled end as overtime', () => {
    const r = computeAttendanceDay(day(['08:00', '19:15']), ctx());
    expect(r).toMatchObject({
      workedMinutes: 615,
      regularMinutes: 480,
      overtimeMinutes: 135,
      undertimeMinutes: 0,
    });
  });

  it('sums multiple pairs and applies the break once', () => {
    const r = computeAttendanceDay(day(['08:00', '12:00'], ['13:00', '17:00']), ctx());
    // 480 gross - 60 break = 420; the hour out at lunch plus the deducted break leaves 60 undertime.
    expect(r).toMatchObject({ workedMinutes: 420, regularMinutes: 420, undertimeMinutes: 60 });
  });

  it('skips the break deduction for short days', () => {
    const r = computeAttendanceDay(day(['08:00', '11:00']), ctx());
    expect(r).toMatchObject({ workedMinutes: 180, undertimeMinutes: 300 });
  });

  it('flags an open time-in as incomplete without undertime or overtime', () => {
    const r = computeAttendanceDay(day(['08:40', '']), ctx());
    expect(r).toMatchObject({
      status: 'INCOMPLETE',
      hasOpenPunch: true,
      lateMinutes: 40,
      undertimeMinutes: 0,
      overtimeMinutes: 0,
      workedMinutes: 0,
    });
  });

  it('flags a stray time-out as incomplete', () => {
    const r = computeAttendanceDay([{ type: 'TIME_OUT', at: at('2026-11-05', '17:00') }], ctx());
    expect(r.status).toBe('INCOMPLETE');
    expect(r.hasOpenPunch).toBe(false);
  });

  it('treats all work on a rest day as overtime', () => {
    const r = computeAttendanceDay(day(['09:00', '13:00']), ctx({ window: null }));
    expect(r).toMatchObject({
      status: 'REST_DAY_WORKED',
      workedMinutes: 180,
      overtimeMinutes: 180,
      regularMinutes: 0,
      scheduledMinutes: 0,
    });
  });

  it('treats work on a holiday as overtime', () => {
    const r = computeAttendanceDay(day(['08:00', '12:00']), ctx({ isHoliday: true }));
    expect(r).toMatchObject({ status: 'HOLIDAY_WORKED', overtimeMinutes: 180 });
  });

  it('handles overnight schedules that end after midnight', () => {
    const punches: Punch[] = [
      { type: 'TIME_IN', at: at('2026-11-05', '22:00') },
      { type: 'TIME_OUT', at: new Date('2026-11-06T07:00:00+08:00') },
    ];
    const r = computeAttendanceDay(
      punches,
      ctx({ window: { startMinute: 1320, endMinute: 1860 } }),
    );
    expect(r).toMatchObject({
      workedMinutes: 480,
      regularMinutes: 480,
      overtimeMinutes: 0,
      undertimeMinutes: 0,
      status: 'PRESENT',
    });
  });

  it('is independent of input order', () => {
    const punches = day(['08:00', '17:00']).reverse();
    expect(computeAttendanceDay(punches, ctx()).workedMinutes).toBe(480);
  });
});
