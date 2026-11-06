import { eachDate } from '../../attendance/domain/work-date';

/**
 * Working dates in an inclusive range (assumption A-5): days the employee is scheduled to work,
 * excluding company holidays. Half-days are not supported.
 */
export function countLeaveDates(
  startDate: string,
  endDate: string,
  isScheduled: (date: string) => boolean,
  isHoliday: (date: string) => boolean,
): string[] {
  return eachDate(startDate, endDate).filter((d) => isScheduled(d) && !isHoliday(d));
}

/** Days per calendar year, for balances on requests that span New Year. */
export function daysByYear(dates: readonly string[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const d of dates) {
    const y = Number(d.slice(0, 4));
    out.set(y, (out.get(y) ?? 0) + 1);
  }
  return out;
}
