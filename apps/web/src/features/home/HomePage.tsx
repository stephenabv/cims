import type { AttendanceDayView } from '@cims/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { errorMessage } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { addDays, formatMinutes, formatTime, formatWorkDate, todayIn } from '@/lib/datetime';
import { useAttendanceRange } from '../attendance/api';
import { DAILY_STATUS } from '../attendance/labels';
import { useCorrectionApprovals, useMyCorrections } from '../corrections/api';

/** Browser zone, used only to pick a date window wide enough to contain the company's "today". */
const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Employee dashboard: greeting, today's attendance, the past week, and pending corrections. */
export function HomePage() {
  const { user } = useAuth();
  if (!user) return null;
  const first = user.fullName.split(/\s+/)[0];
  return (
    <div className="grid gap-6">
      <section className="relative overflow-hidden rounded-[var(--radius-card)] bg-brand-950 px-6 py-7 text-white shadow-[var(--shadow-card)] sm:px-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-20 -right-16 size-64 rounded-full bg-sun-400/25 blur-3xl"
        />
        <p className="text-xs font-semibold tracking-wider text-sun-300 uppercase">Dashboard</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
          {greeting()}, {first}
        </h1>
        <p className="mt-2 text-sm text-brand-200">
          <span className="font-mono">{user.accountNumber}</span> · {user.role.name}
        </p>
      </section>
      {user.employeeId ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <AttendanceOverview />
          <CorrectionsTile />
        </div>
      ) : (
        <Card title="Your account">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            This account is not linked to an employee record, so there is no attendance to show.
          </p>
        </Card>
      )}
    </div>
  );
}

function AttendanceOverview() {
  const today = todayIn(BROWSER_ZONE);
  const range = useAttendanceRange(undefined, addDays(today, -7), addDays(today, 1));

  if (range.isError)
    return (
      <div className="lg:col-span-2">
        <Alert tone="error">{errorMessage(range.error)}</Alert>
      </div>
    );
  if (range.isPending)
    return (
      <Card title="Today" className="lg:col-span-2">
        <Skeleton className="h-24" />
      </Card>
    );

  const { timezone, days } = range.data;
  const companyToday = todayIn(timezone);
  const todayRow = days.find((d) => d.workDate === companyToday);
  const week = days
    .filter((d) => d.workDate < companyToday)
    .slice(-5)
    .reverse();

  return (
    <Card
      title="Today"
      description={formatWorkDate(companyToday)}
      className="lg:col-span-2"
      actions={
        <Link
          className="text-sm font-semibold text-brand-700 hover:underline dark:text-brand-200"
          to="/app/attendance"
        >
          Full history
        </Link>
      }
    >
      {todayRow ? (
        <TodayStats day={todayRow} timezone={timezone} />
      ) : (
        <p className="text-sm">No record yet.</p>
      )}
      {week.length > 0 && (
        <>
          <h3 className="mt-6 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Recent days
          </h3>
          <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
            {week.map((d) => (
              <li
                key={d.workDate}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span className="font-medium">{formatWorkDate(d.workDate)}</span>
                <span className="flex items-center gap-3 text-slate-600 tabular-nums dark:text-slate-400">
                  {d.firstIn && (
                    <span>
                      {formatTime(d.firstIn, timezone)} – {formatTime(d.lastOut, timezone)}
                    </span>
                  )}
                  <Badge tone={DAILY_STATUS[d.status].tone}>{DAILY_STATUS[d.status].label}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function TodayStats({ day, timezone }: { day: AttendanceDayView; timezone: string }) {
  const status = DAILY_STATUS[day.status];
  return (
    <div className="grid gap-4">
      <div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Time in" value={formatTime(day.firstIn, timezone)} />
        <Stat label="Time out" value={formatTime(day.lastOut, timezone)} />
        <Stat label="Worked" value={day.workedMinutes ? formatMinutes(day.workedMinutes) : '—'} />
        <Stat label="Late" value={day.lateMinutes ? formatMinutes(day.lateMinutes) : '—'} />
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800/60">
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function CorrectionsTile() {
  const mine = useMyCorrections('PENDING', 1);
  const review = useCorrectionApprovals(1);
  const pending = mine.data?.meta.total ?? 0;
  const waiting = review.data?.meta.total ?? 0;
  return (
    <Card
      title="Attendance corrections"
      description="Wrong or missing punch? Ask for it to be fixed."
    >
      <ul className="grid gap-2 text-sm">
        <TileLink to="/app/attendance/corrections" label="Your pending requests" count={pending} />
        {waiting > 0 && (
          <TileLink
            to="/app/attendance/corrections?tab=review"
            label="Waiting for your review"
            count={waiting}
            accent
          />
        )}
        <li>
          <Link
            to="/app/attendance"
            className="block rounded-xl px-3 py-2.5 font-semibold text-brand-700 hover:bg-slate-50 dark:text-brand-200 dark:hover:bg-slate-800"
          >
            Request a correction from your history
          </Link>
        </li>
      </ul>
    </Card>
  );
}

function TileLink({
  to,
  label,
  count,
  accent,
}: {
  to: string;
  label: string;
  count: number;
  accent?: boolean;
}) {
  return (
    <li>
      <Link
        to={to}
        className="flex items-center justify-between rounded-xl px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800"
      >
        <span>{label}</span>
        <span
          className={
            accent
              ? 'rounded-full bg-sun-400 px-2 text-xs font-bold text-brand-950'
              : 'rounded-full bg-slate-100 px-2 text-xs font-semibold dark:bg-slate-800'
          }
        >
          {count}
        </span>
      </Link>
    </li>
  );
}

function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
