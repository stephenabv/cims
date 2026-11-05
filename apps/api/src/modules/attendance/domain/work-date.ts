import { DateTime } from 'luxon';

/** Business date (YYYY-MM-DD) of an instant in the company timezone. */
export function workDateOf(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toISODate()!;
}

/** Instant for `minutes` after local midnight of `workDate` in `timezone` (handles >24h for overnight shifts). */
export function instantAt(workDate: string, minutes: number, timezone: string): Date {
  return DateTime.fromISO(workDate, { zone: timezone }).startOf('day').plus({ minutes }).toJSDate();
}

/** ISO weekday 1 (Mon) … 7 (Sun) of a business date. */
export function isoWeekday(workDate: string): number {
  return DateTime.fromISO(workDate, { zone: 'UTC' }).weekday;
}

/** Postgres DATE columns round-trip as UTC midnight. */
export function dateColumn(workDate: string): Date {
  return new Date(`${workDate}T00:00:00Z`);
}

export function fromDateColumn(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of business dates between two ISO dates. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = DateTime.fromISO(from, { zone: 'UTC' });
  const end = DateTime.fromISO(to, { zone: 'UTC' });
  while (cursor <= end) {
    out.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 1 });
  }
  return out;
}
