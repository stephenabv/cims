import { statusWithPunches, statusWithoutPunches, summarise } from './attendance-query.service';

describe('statusWithoutPunches', () => {
  const today = '2026-11-05';
  it('derives the status of days without punches', () => {
    expect(statusWithoutPunches('2026-01-01', today, '2026-02-01', true, false)).toBe(
      'NOT_EMPLOYED',
    );
    expect(statusWithoutPunches('2026-11-03', today, '2026-01-01', true, true)).toBe('HOLIDAY');
    expect(statusWithoutPunches('2026-11-01', today, '2026-01-01', false, false)).toBe('REST_DAY');
    expect(statusWithoutPunches('2026-11-04', today, '2026-01-01', true, false)).toBe('ABSENT');
    expect(statusWithoutPunches(today, today, '2026-01-01', true, false)).toBe('NOT_YET_IN');
  });
});

describe('statusWithPunches', () => {
  const today = '2026-11-05';
  const open = { status: 'INCOMPLETE' as const, hasOpenPunch: true, lateMinutes: 0 };
  it('shows a shift still open today by arrival, not as incomplete', () => {
    expect(statusWithPunches(open, today, today, true, false)).toBe('PRESENT');
    expect(statusWithPunches({ ...open, lateMinutes: 12 }, today, today, true, false)).toBe('LATE');
    expect(statusWithPunches(open, today, today, false, false)).toBe('REST_DAY_WORKED');
    expect(statusWithPunches(open, today, today, true, true)).toBe('HOLIDAY_WORKED');
  });
  it('keeps past open punches and recorded statuses as they are', () => {
    expect(statusWithPunches(open, '2026-11-04', today, true, false)).toBe('INCOMPLETE');
    expect(
      statusWithPunches(
        { ...open, status: 'LATE', hasOpenPunch: false, lateMinutes: 5 },
        today,
        today,
        true,
        false,
      ),
    ).toBe('LATE');
  });
});

describe('summarise', () => {
  it('totals the range', () => {
    const day = (over: object) => ({
      workDate: '2026-11-04',
      status: 'PRESENT' as const,
      firstIn: null,
      lastOut: null,
      workedMinutes: 0,
      regularMinutes: 0,
      lateMinutes: 0,
      undertimeMinutes: 0,
      overtimeMinutes: 0,
      scheduledMinutes: 480,
      punches: [],
      ...over,
    });
    expect(
      summarise([
        day({ workedMinutes: 450, lateMinutes: 30, status: 'LATE' }),
        day({ status: 'ABSENT' }),
        day({ status: 'INCOMPLETE', workedMinutes: 60 }),
      ]),
    ).toEqual({
      daysWorked: 2,
      totalWorkedMinutes: 510,
      totalLateMinutes: 30,
      lateCount: 1,
      totalUndertimeMinutes: 0,
      totalOvertimeMinutes: 0,
      absences: 1,
      incomplete: 1,
    });
  });
});
