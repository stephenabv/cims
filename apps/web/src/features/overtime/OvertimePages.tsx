import {
  OVERTIME_STATUSES,
  type OvertimePolicy,
  type OvertimeRecordView,
  type OvertimeStatus,
  PERMISSIONS,
} from '@cims/shared';
import { clsx } from 'clsx';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loading, useQueryState, WithCompanyTimezone } from '@/components/PageState';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { formatMinutes, formatWorkDate, todayIn } from '@/lib/datetime';
import { useDepartments } from '../employees/api';
import { useOvertimeList, useOvertimeSummary, useSaveOvertimePolicy } from './api';
import { OVERTIME_STATUS } from './labels';
import { OvertimeDecisionDialog, OvertimeRecordCard } from './OvertimeRecordCard';

const PAGE_SIZE = 20;

/** Department filter, shown only to people whose scope spans departments. */
function DepartmentFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { can } = useAuth();
  const wide = can(PERMISSIONS.OVERTIME_VIEW_ALL) || can(PERMISSIONS.OVERTIME_VIEW_DEPARTMENT);
  const departments = useDepartments(wide);
  if (!wide) return null;
  return (
    <SelectField
      label="Department"
      placeholder="All departments in my scope"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
    />
  );
}

/** Overtime of the people the viewer supervises or oversees; pending items first (§3.4, §3.6). */
export function OvertimeApprovalsPage() {
  return <WithCompanyTimezone>{(tz) => <Approvals timezone={tz} />}</WithCompanyTimezone>;
}

function Approvals({ timezone }: { timezone: string }) {
  const { params, update } = useQueryState();
  const raw = params.get('status');
  const status: OvertimeStatus | undefined =
    raw === 'ALL' ? undefined : (OVERTIME_STATUSES.find((s) => s === raw) ?? 'PENDING');
  const page = Math.max(1, Number(params.get('page')) || 1);
  const departmentId = params.get('departmentId') ?? '';
  const list = useOvertimeList({
    status,
    departmentId: departmentId || undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const [deciding, setDeciding] = useState<{
    record: OvertimeRecordView;
    decision: 'APPROVE' | 'REJECT';
  } | null>(null);

  const tabs: { value: string; label: string }[] = [
    ...OVERTIME_STATUSES.map((s) => ({ value: s, label: OVERTIME_STATUS[s].label })),
    { value: 'ALL', label: 'All' },
  ];
  const current = status ?? 'ALL';

  return (
    <>
      <PageHeader
        title="Overtime"
        description="Time worked beyond schedule by the people you supervise or oversee. Only approved overtime is paid."
      />
      <p className="-mt-4 mb-4 text-sm">
        <Link
          to="/app/overtime/summary"
          className="text-brand-700 hover:underline dark:text-brand-100"
        >
          Overtime and undertime summary →
        </Link>
      </p>
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Overtime status">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={current === t.value}
            onClick={() => update({ status: t.value === 'PENDING' ? '' : t.value, page: '' })}
            className={clsx(
              'inline-flex min-h-9 items-center rounded-full px-3 text-sm font-medium ring-1 ring-inset',
              current === t.value
                ? 'bg-brand-700 text-white ring-brand-700'
                : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mb-4 max-w-sm">
        <DepartmentFilter
          value={departmentId}
          onChange={(v) => update({ departmentId: v, page: '' })}
        />
      </div>

      {list.isError ? (
        <Alert tone="error">{errorMessage(list.error)}</Alert>
      ) : list.isPending ? (
        <Loading />
      ) : list.data.data.length === 0 ? (
        <EmptyState
          title={status === 'PENDING' ? 'Nothing to approve' : 'No overtime here'}
          description={
            status === 'PENDING'
              ? 'Overtime appears here once an employee clocks out after their schedule.'
              : undefined
          }
        />
      ) : (
        <>
          <ul className="grid gap-3">
            {list.data.data.map((r) => (
              <OvertimeRecordCard
                key={r.id}
                record={r}
                timezone={timezone}
                actions={
                  r.can.decide && (
                    <>
                      {r.status !== 'REJECTED' && (
                        <Button
                          variant="secondary"
                          onClick={() => setDeciding({ record: r, decision: 'REJECT' })}
                        >
                          Reject
                        </Button>
                      )}
                      <Button
                        variant={r.status === 'PENDING' ? 'primary' : 'secondary'}
                        onClick={() => setDeciding({ record: r, decision: 'APPROVE' })}
                      >
                        {r.status === 'APPROVED' ? 'Change' : 'Approve'}
                      </Button>
                    </>
                  )
                }
              />
            ))}
          </ul>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={list.data.meta.total}
            onPage={(p) => update({ page: p > 1 ? String(p) : '' })}
          />
        </>
      )}
      {deciding && (
        <OvertimeDecisionDialog
          key={deciding.record.id + deciding.decision}
          {...deciding}
          onClose={() => setDeciding(null)}
        />
      )}
    </>
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** Daily and monthly overtime/undertime per employee (§3.6); feeds payroll in a later phase. */
export function OvertimeSummaryPage() {
  return <WithCompanyTimezone>{(tz) => <Summary timezone={tz} />}</WithCompanyTimezone>;
}

function Summary({ timezone }: { timezone: string }) {
  const { params, update } = useQueryState();
  const today = todayIn(timezone);
  const period = params.get('period') === 'day' ? 'day' : 'month';
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '')
    ? params.get('month')!
    : today.slice(0, 7);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : today;
  const departmentId = params.get('departmentId') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const range = period === 'day' ? { from: day, to: day } : monthRange(month);
  const summary = useOvertimeSummary({
    ...range,
    departmentId: departmentId || undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const label =
    period === 'day'
      ? formatWorkDate(day, { year: true })
      : new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        });

  return (
    <>
      <PageHeader
        title="Overtime and undertime"
        description="Totals per employee for a day or a month, within your scope."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <SelectField
          label="Period"
          value={period}
          onChange={(e) => update({ period: e.target.value === 'day' ? 'day' : '', page: '' })}
          options={[
            { value: 'month', label: 'Month' },
            { value: 'day', label: 'Day' },
          ]}
        />
        {period === 'day' ? (
          <TextField
            label="Date"
            type="date"
            value={day}
            max={today}
            onChange={(e) => e.target.value && update({ date: e.target.value, page: '' })}
          />
        ) : (
          <TextField
            label="Month"
            type="month"
            value={month}
            max={today.slice(0, 7)}
            onChange={(e) => e.target.value && update({ month: e.target.value, page: '' })}
          />
        )}
        <DepartmentFilter
          value={departmentId}
          onChange={(v) => update({ departmentId: v, page: '' })}
        />
      </div>

      {summary.isError ? (
        <Alert tone="error">{errorMessage(summary.error)}</Alert>
      ) : summary.isPending ? (
        <Loading />
      ) : (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Approved overtime', value: summary.data.totals.approvedMinutes },
              { label: 'Awaiting approval', value: summary.data.totals.pendingMinutes },
              { label: 'Undertime counted', value: summary.data.totals.undertimeCountedMinutes },
              { label: 'Late', value: summary.data.totals.lateMinutes },
            ].map((t) => (
              <div
                key={t.label}
                className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
              >
                <dt className="text-xs text-slate-500 dark:text-slate-400">{t.label}</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">
                  {formatMinutes(t.value)}
                </dd>
              </div>
            ))}
          </dl>
          {summary.data.data.length === 0 ? (
            <EmptyState
              title="No attendance in this period"
              description="Pick another period or department."
            />
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Overtime and undertime for {label}</caption>
                  <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Employee
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Days
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        OT approved
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        OT pending
                      </th>
                      <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                        OT rejected
                      </th>
                      <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                        OT below minimum
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Undertime counted
                      </th>
                      <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                        Undertime total
                      </th>
                      <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                        Late
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
                    {summary.data.data.map((r) => (
                      <tr key={r.employee.id}>
                        <td className="px-4 py-3">
                          <Link
                            to={`/app/attendance/employees/${r.employee.id}?from=${range.from}&to=${range.to}`}
                            className="font-medium text-brand-700 hover:underline dark:text-brand-100"
                          >
                            {r.employee.fullName}
                          </Link>
                          <span className="block text-xs text-slate-500 dark:text-slate-400">
                            {r.employee.department ?? r.employee.accountNumber}
                          </span>
                        </td>
                        <td className="px-4 py-3">{r.daysWorked}</td>
                        <td className="px-4 py-3">{formatMinutes(r.overtime.approvedMinutes)}</td>
                        <td className="px-4 py-3">{formatMinutes(r.overtime.pendingMinutes)}</td>
                        <td className="hidden px-4 py-3 lg:table-cell">
                          {formatMinutes(r.overtime.rejectedMinutes)}
                        </td>
                        <td className="hidden px-4 py-3 lg:table-cell">
                          {formatMinutes(r.overtime.unrecordedMinutes)}
                        </td>
                        <td className="px-4 py-3">{formatMinutes(r.undertime.countedMinutes)}</td>
                        <td className="hidden px-4 py-3 md:table-cell">
                          {formatMinutes(r.undertime.totalMinutes)}
                          {r.undertime.days > 0 && (
                            <span className="text-xs text-slate-500">
                              {' '}
                              ({r.undertime.days} {r.undertime.days === 1 ? 'day' : 'days'})
                            </span>
                          )}
                        </td>
                        <td className="hidden px-4 py-3 md:table-cell">
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
                total={summary.data.meta.total}
                onPage={(p) => update({ page: p > 1 ? String(p) : '' })}
              />
            </>
          )}
          <PolicyCard policy={summary.data.policy} />
        </>
      )}
    </>
  );
}

function PolicyCard({ policy }: { policy: OvertimePolicy }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  return (
    <section className="mt-6 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Company rules</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Overtime shorter than {policy.overtimeMinimumMinutes} minutes a day is not sent for
            approval.{' '}
            {policy.undertimeThresholdMinutes > 0
              ? `Undertime shorter than ${policy.undertimeThresholdMinutes} minutes a day is not counted.`
              : 'All undertime is counted.'}
          </p>
        </div>
        {can(PERMISSIONS.PAYROLL_CONFIGURE) && (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>
      {editing && <PolicyDialog policy={policy} onClose={() => setEditing(false)} />}
    </section>
  );
}

function PolicyDialog({ policy, onClose }: { policy: OvertimePolicy; onClose: () => void }) {
  const save = useSaveOvertimePolicy();
  const [form, setForm] = useState({
    overtimeMinimumMinutes: String(policy.overtimeMinimumMinutes),
    undertimeThresholdMinutes: String(policy.undertimeThresholdMinutes),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const field = (k: keyof typeof form) => ({
    value: form[k],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value })),
    error: errors[k],
    type: 'number',
    min: 0,
    max: 240,
    inputMode: 'numeric' as const,
  });
  return (
    <Dialog open onClose={onClose} title="Overtime and undertime rules">
      <form
        noValidate
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const next: Record<string, string> = {};
          const values = {} as OvertimePolicy;
          for (const k of Object.keys(form) as (keyof typeof form)[]) {
            const n = Number(form[k]);
            if (form[k].trim() === '' || !Number.isInteger(n) || n < 0 || n > 240)
              next[k] = 'Enter whole minutes from 0 to 240';
            values[k] = n;
          }
          setErrors(next);
          if (Object.keys(next).length) return;
          save.mutate(values, {
            onSuccess: onClose,
            onError: (err) =>
              setErrors(
                err instanceof ApiError && Object.keys(err.fieldErrors()).length
                  ? err.fieldErrors()
                  : { form: errorMessage(err) },
              ),
          });
        }}
      >
        <TextField
          label="Minimum overtime (minutes a day)"
          hint="Shorter overtime is not sent for approval."
          {...field('overtimeMinimumMinutes')}
        />
        <TextField
          label="Undertime threshold (minutes a day)"
          hint="Shorter undertime is shown but not counted toward deductions."
          {...field('undertimeThresholdMinutes')}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          New rules apply to attendance recorded or corrected from now on.
        </p>
        {errors.form && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errors.form}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
