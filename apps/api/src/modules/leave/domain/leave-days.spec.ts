import { countLeaveDates, daysByYear } from './leave-days';

const weekday = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w >= 1 && w <= 5;
};

describe('countLeaveDates', () => {
  it('counts scheduled days and skips weekends and holidays', () => {
    // 2026-12-24 (Thu) … 2027-01-04 (Mon); 25 Dec and 1 Jan are holidays.
    const holidays = new Set(['2026-12-25', '2027-01-01']);
    const dates = countLeaveDates('2026-12-24', '2027-01-04', weekday, (d) => holidays.has(d));
    expect(dates).toEqual([
      '2026-12-24',
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-04',
    ]);
    expect([...daysByYear(dates)]).toEqual([
      [2026, 5],
      [2027, 1],
    ]);
  });

  it('returns nothing for a range of rest days', () => {
    expect(countLeaveDates('2026-11-07', '2026-11-08', weekday, () => false)).toEqual([]);
  });
});
