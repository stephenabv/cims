import { clsx } from 'clsx';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { SelectField } from '@/components/ui/SelectField';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { errorMessage } from '@/lib/api-client';
import { formatMinutes, formatTime, todayIn } from '@/lib/datetime';
import { useDepartments } from '../employees/api';
import { useKioskStatus } from '../kiosk/api';
import { useAttendanceMonitor } from './api';
import { DAILY_STATUS, MONITOR_STATUSES } from './labels';

const PAGE_SIZE = 25;

/** Daily attendance board for HR, executives and department heads (§3.1, §3.8). */
export function AttendanceMonitorPage() {
  // The public kiosk status supplies the company timezone, so "today" is the office's today.
  const company = useKioskStatus(null);
  const tz = company.data?.timezone;
  if (company.isError) return <Alert tone="error">{errorMessage(company.error)}</Alert>;
  if (!tz)
    return (
      <div className="flex justify-center py-12 text-brand-700">
        <Spinner />
      </div>
    );
  return <Board timezone={tz} />;
}

function Board({ timezone }: { timezone: string }) {
  const [params, setParams] = useSearchParams();
  const date = params.get('date') ?? todayIn(timezone);
  const page = Math.max(1, Number(params.get('page')) || 1);
  const status = (params.get('status') ?? '') as (typeof MONITOR_STATUSES)[number] | '';
  const departmentId = params.get('departmentId') ?? '';
  const [search, setSearch] = useState(params.get('search') ?? '');
  const currentSearch = params.get('search') ?? '';

  function update(next: Record<string, string>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p, { replace: true });
  }

  useEffect(() => {
    if (search === currentSearch) return;
    const t = setTimeout(() => update({ search, page: '1' }), 300);
    return () => clearTimeout(t);
    // `update` reads the latest params each render
  }, [search, currentSearch]);

  const departments = useDepartments();
  const board = useAttendanceMonitor({
    date,
    page,
    pageSize: PAGE_SIZE,
    status: status || undefined,
    departmentId: departmentId || undefined,
    search: currentSearch || undefined,
  });

  return (
    <>
      <PageHeader
        title="Attendance monitor"
        description={`Who is in, late or absent. Times are shown in ${timezone}; refreshes every minute.`}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <TextField
          label="Date"
          type="date"
          value={date}
          max={todayIn(timezone)}
          onChange={(e) => e.target.value && update({ date: e.target.value, page: '1' })}
        />
        <SelectField
          label="Department"
          placeholder="All departments in my scope"
          value={departmentId}
          onChange={(e) => update({ departmentId: e.target.value, page: '1' })}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
        />
        <TextField
          label="Search"
          placeholder="Name or account number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {board.data && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          <StatusChip
            label="All"
            count={Object.values(board.data.counts).reduce((a, b) => a + (b ?? 0), 0)}
            active={!status}
            onClick={() => update({ status: '', page: '1' })}
          />
          {MONITOR_STATUSES.filter((s) => board.data.counts[s]).map((s) => (
            <StatusChip
              key={s}
              label={DAILY_STATUS[s].label}
              count={board.data.counts[s] ?? 0}
              active={status === s}
              onClick={() => update({ status: status === s ? '' : s, page: '1' })}
            />
          ))}
        </div>
      )}

      {board.isError ? (
        <Alert tone="error">{errorMessage(board.error)}</Alert>
      ) : board.isPending ? (
        <div className="flex justify-center py-12 text-brand-700">
          <Spinner />
        </div>
      ) : board.data.rows.length === 0 ? (
        <EmptyState title="Nobody matches" description="Try another date, status or search." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Attendance on {date}</caption>
              <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Employee
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                    Department
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    In
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
                    Out
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                    Worked
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                    Late
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {board.data.rows.map((r) => (
                  <tr key={r.employee.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/app/attendance/employees/${r.employee.id}?from=${date.slice(0, 8)}01&to=${date}`}
                        className="font-medium text-brand-700 hover:underline dark:text-brand-100"
                      >
                        {r.employee.fullName}
                      </Link>
                      <p className="font-mono text-xs text-slate-500">{r.employee.accountNumber}</p>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      {r.employee.department ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={DAILY_STATUS[r.status].tone}>
                        {DAILY_STATUS[r.status].label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                      {formatTime(r.firstIn, timezone)}
                    </td>
                    <td className="hidden px-4 py-3 whitespace-nowrap tabular-nums sm:table-cell">
                      {formatTime(r.lastOut, timezone)}
                    </td>
                    <td className="hidden px-4 py-3 tabular-nums lg:table-cell">
                      {formatMinutes(r.workedMinutes)}
                    </td>
                    <td className="hidden px-4 py-3 tabular-nums lg:table-cell">
                      {formatMinutes(r.lateMinutes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={board.data.meta.total}
            onPage={(p) => update({ page: String(p) })}
          />
        </>
      )}
    </>
  );
}

function StatusChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-sm font-medium ring-1 ring-inset',
        active
          ? 'bg-brand-700 text-white ring-brand-700'
          : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700',
      )}
    >
      {label}
      <span className="tabular-nums opacity-80">{count}</span>
    </button>
  );
}
