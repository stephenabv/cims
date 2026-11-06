/**
 * Display helpers that render instants in the company timezone (not the browser's), so a manager
 * travelling abroad still sees office-local punch times.
 */

/** "8:05 AM" for an ISO instant, in the given IANA zone. */
export function formatTime(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-PH', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

/** "Wed, Nov 4" for a calendar date (YYYY-MM-DD). Calendar dates carry no zone, so format as UTC. */
export function formatWorkDate(date: string, opts: { year?: boolean } = {}): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(opts.year ? { year: 'numeric' } : {}),
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Today's calendar date (YYYY-MM-DD) in the given zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Adds whole days to a calendar date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "7h 30m", "45m" or "—" for zero. */
export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Minutes after midnight to "HH:MM" (for <input type="time">), and back. */
export const minuteToTime = (m: number): string =>
  `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export function timeToMinute(t: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(t);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Wall-clock parts of an instant in a zone: { date: 'YYYY-MM-DD', time: 'HH:MM' } (24-hour). */
export function wallClock(iso: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}
