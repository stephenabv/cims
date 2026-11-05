import type { AttendanceSummary } from '@cims/shared';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { errorMessage } from '@/lib/api-client';
import { addDays, formatMinutes, formatTime, formatWorkDate, todayIn } from '@/lib/datetime';
import { useAttendanceRange } from './api';
import { DAILY_STATUS } from './labels';

/** Matches the API's 93-day range limit. */
const MAX_RANGE_DAYS = 92;

function defaultRange(): { from: string; to: string } {
  // Browser-local "today" only seeds the picker; the API clamps to company-local today.
  const to = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  return { from: `${to.slice(0, 8)}01`, to };
}

export function MyAttendancePage() {
  return <AttendanceHistory />;
}

export function EmployeeAttendancePage() {
  const { id } = useParams<{ id: string }>();
  return <AttendanceHistory employeeId={id} />;
}

function AttendanceHistory({ employeeId }: { employeeId?: string }) {
  const [params, setParams] = useSearchParams();
  const [initial] = useState(defaultRange);
  const from = params.get('from') ?? initial.from;
  const to = params.get('to') ?? initial.to;
  const rangeError =
    from > to
      ? 'Start date must be on or before the end date.'
      : addDays(from, MAX_RANGE_DAYS) < to
        ? 'Choose a range of 93 days or fewer.'
        : undefined;
  const range = useAttendanceRange(employeeId, from, to);

  const setRange = (next: { from?: string; to?: string }) => {
    const p = new URLSearchParams(params);
    if (next.from) p.set('from', next.from);
    if (next.to) p.set('to', next.to);
    setParams(p, { replace: true });
  };

  const tz = range.data?.timezone ?? 'Asia/Manila';
  const title = employeeId ? (range.data?.employee.fullName ?? 'Attendance') : 'My attendance';

  return (
    <>
      <PageHeader
        title={title}
        description={
          employeeId && range.data
            ? `${range.data.employee.accountNumber} · times shown in ${tz}`
            : `Your time in and time out records. Times are shown in ${tz}.`
        }
      />
      {employeeId && (
        <p className="-mt-4 mb-4 text-sm">
          <Link
            to="/app/attendance/monitor"
            className="text-brand-700 hover:underline dark:text-brand-100"
          >
            ← Back to attendance monitor
          </Link>
        </p>
      )}

      <div className="mb-4 grid max-w-md grid-cols-2 gap-3">
        <TextField
          label="From"
          type="date"
          value={from}
          max={to}
          onChange={(e) => e.target.value && setRange({ from: e.target.value })}
        />
        <TextField
          label="To"
          type="date"
          value={to}
          min={from}
          onChange={(e) => e.target.value && setRange({ to: e.target.value })}
          error={rangeError}
        />
      </div>

      {rangeError ? null : range.isError ? (
        <Alert tone="error">{errorMessage(range.error)}</Alert>
      ) : range.isPending ? (
        <div className="flex justify-center py-12 text-brand-700">
          <Spinner />
        </div>
      ) : (
        <>
          <SummaryTiles summary={range.data.summary} />
          {range.data.days.length === 0 ? (
            <EmptyState title="No days in this range" description="Pick an earlier date range." />
          ) : (
            <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Daily attendance</caption>
                <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Date
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      In
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Out
                    </th>
                    <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
                      Worked
                    </th>
                    <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                      Late
                    </th>
                    <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                      Undertime
                    </th>
                    <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                      Overtime
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {range.data.days.map((d) => (
                    <tr key={d.workDate}>
                      <td className="px-4 py-3 whitespace-nowrap">{formatWorkDate(d.workDate)}</td>
                      <td className="px-4 py-3">
                        <Badge tone={DAILY_STATUS[d.status].tone}>
                          {DAILY_STATUS[d.status].label}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                        {formatTime(d.firstIn, tz)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                        {formatTime(d.lastOut, tz)}
                      </td>
                      <td className="hidden px-4 py-3 tabular-nums sm:table-cell">
                        {formatMinutes(d.workedMinutes)}
                      </td>
                      <td className="hidden px-4 py-3 tabular-nums md:table-cell">
                        {formatMinutes(d.lateMinutes)}
                      </td>
                      <td className="hidden px-4 py-3 tabular-nums md:table-cell">
                        {formatMinutes(d.undertimeMinutes)}
                      </td>
                      <td className="hidden px-4 py-3 tabular-nums md:table-cell">
                        {formatMinutes(d.overtimeMinutes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Overtime shown here is time worked beyond schedule. Only approved overtime is paid.
          </p>
        </>
      )}
    </>
  );
}

function SummaryTiles({ summary }: { summary: AttendanceSummary }) {
  const tiles = [
    { label: 'Days worked', value: String(summary.daysWorked) },
    { label: 'Hours worked', value: formatMinutes(summary.totalWorkedMinutes) },
    {
      label: 'Times late',
      value: `${summary.lateCount} (${formatMinutes(summary.totalLateMinutes)})`,
    },
    { label: 'Absences', value: String(summary.absences) },
    { label: 'Undertime', value: formatMinutes(summary.totalUndertimeMinutes) },
    { label: 'Incomplete days', value: String(summary.incomplete) },
  ];
  return (
    <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
        >
          <dt className="text-xs text-slate-500 dark:text-slate-400">{t.label}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{t.value}</dd>
        </div>
      ))}
    </dl>
  );
}
