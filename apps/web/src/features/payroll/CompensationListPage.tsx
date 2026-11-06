import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loading, useQueryState } from '@/components/PageState';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { errorMessage } from '@/lib/api-client';
import { formatWorkDate } from '@/lib/datetime';
import { formatPeso } from '@/lib/money';
import { useDepartments } from '../employees/api';
import { useCompensationList } from './api';
import { PAY_SCHEDULE } from './labels';

const PAGE_SIZE = 20;

/** Every active employee with the pay terms in force today (spec §3.4). */
export function CompensationListPage() {
  const { params, update } = useQueryState();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const search = params.get('search') ?? '';
  const departmentId = params.get('departmentId') ?? '';
  const missing = params.get('missing') === 'true';
  const [draft, setDraft] = useState(search);
  const departments = useDepartments();

  // Search as the user types, without a request per keystroke.
  useEffect(() => {
    const next = draft.trim();
    if (next === search) return;
    const t = setTimeout(() => update({ search: next, page: '' }), 300);
    return () => clearTimeout(t);
  }, [draft, search]); // `update` reads the latest params on each render

  const list = useCompensationList({
    search: search || undefined,
    departmentId: departmentId || undefined,
    missing,
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <>
      <PageHeader
        title="Pay setup"
        description="Hourly rates, pay schedules, allowances and deductions for each employee."
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <TextField
          label="Search"
          type="search"
          placeholder="Name or account number"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        {departments.data && (
          <SelectField
            label="Department"
            placeholder="All departments"
            value={departmentId}
            onChange={(e) => update({ departmentId: e.target.value, page: '' })}
            options={departments.data.map((d) => ({ value: d.id, label: d.name }))}
          />
        )}
        <SelectField
          label="Show"
          value={missing ? 'missing' : ''}
          onChange={(e) => update({ missing: e.target.value ? 'true' : '', page: '' })}
          options={[
            { value: '', label: 'Everyone' },
            { value: 'missing', label: 'Without pay terms' },
          ]}
        />
      </div>

      {list.isError ? (
        <Alert tone="error">{errorMessage(list.error)}</Alert>
      ) : list.isPending ? (
        <Loading />
      ) : list.data.data.length === 0 ? (
        <EmptyState
          title={missing ? 'Everyone has pay terms' : 'No employees found'}
          description={missing ? undefined : 'Try another search or department.'}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Employees and their current pay terms</caption>
              <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Employee
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Hourly rate
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                    Pay schedule
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
                    Allowances & deductions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {list.data.data.map((r) => (
                  <tr key={r.employee.id}>
                    <td className="px-4 py-3">
                      <Link
                        to={`/app/payroll/employees/${r.employee.id}`}
                        className="font-medium text-brand-700 hover:underline dark:text-brand-100"
                      >
                        {r.employee.fullName}
                      </Link>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {r.employee.accountNumber}
                        {r.employee.department && ` · ${r.employee.department}`}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {r.current ? (
                        <>
                          {formatPeso(r.current.hourlyRateCentavos)}/h
                          <span className="block text-xs text-slate-500 dark:text-slate-400">
                            since {formatWorkDate(r.current.effectiveFrom, { year: true })}
                          </span>
                        </>
                      ) : (
                        <Badge tone="warning">Not set</Badge>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      {r.current ? PAY_SCHEDULE[r.current.paySchedule] : '—'}
                    </td>
                    <td className="hidden px-4 py-3 tabular-nums sm:table-cell">{r.activeItems}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={list.data.meta.total}
            onPage={(p) => update({ page: p > 1 ? String(p) : '' })}
          />
        </>
      )}
    </>
  );
}
