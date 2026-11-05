import { ACCOUNT_STATUSES, type EmployeeListQuery, PERMISSIONS } from '@cims/shared';
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
import { useAuth } from '@/lib/auth';
import { useDepartments, useEmployees } from './api';
import { ACCOUNT_STATUS } from './labels';

const PAGE_SIZE = 20;

export function EmployeesPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const departmentId = params.get('departmentId') ?? '';
  const accountStatus = (params.get('accountStatus') ?? '') as
    | EmployeeListQuery['accountStatus']
    | '';
  const [search, setSearch] = useState(params.get('search') ?? '');

  // Debounce typing into the URL so the list query does not fire on every keystroke.
  const currentSearch = params.get('search') ?? '';
  useEffect(() => {
    if (search === currentSearch) return;
    const t = setTimeout(() => update({ search, page: '1' }), 300);
    return () => clearTimeout(t);
  }, [search, currentSearch]); // `update` reads the latest params on each render

  function update(next: Record<string, string>) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    setParams(p, { replace: true });
  }

  const departments = useDepartments();
  const list = useEmployees({
    page,
    pageSize: PAGE_SIZE,
    search: params.get('search') || undefined,
    departmentId: departmentId || undefined,
    accountStatus: accountStatus || undefined,
  });

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader title="Employees" description="Employee records you are allowed to see." />
        {can(PERMISSIONS.EMPLOYEES_CREATE) && (
          <Link
            to="/app/employees/new"
            className="inline-flex min-h-10 items-center rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white hover:bg-brand-800"
          >
            Add employee
          </Link>
        )}
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <TextField
          label="Search"
          placeholder="Name, account number or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SelectField
          label="Department"
          placeholder="All departments"
          value={departmentId}
          onChange={(e) => update({ departmentId: e.target.value, page: '1' })}
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
        />
        <SelectField
          label="Account status"
          placeholder="Any status"
          value={accountStatus}
          onChange={(e) => update({ accountStatus: e.target.value, page: '1' })}
          options={ACCOUNT_STATUSES.map((s) => ({ value: s, label: ACCOUNT_STATUS[s].label }))}
        />
      </div>

      {list.isError ? (
        <Alert tone="error">{errorMessage(list.error)}</Alert>
      ) : list.isPending ? (
        <div className="flex justify-center py-12 text-brand-700">
          <Spinner />
        </div>
      ) : list.data.data.length === 0 ? (
        <EmptyState title="No employees found" description="Try a different search or filter." />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Employees</caption>
              <thead className="border-b border-slate-200 text-xs text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Name
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
                    Account no.
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                    Department
                  </th>
                  <th scope="col" className="hidden px-4 py-3 font-medium lg:table-cell">
                    Role
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {list.data.data.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/app/employees/${e.id}`}
                        className="font-medium text-brand-700 hover:underline dark:text-brand-100"
                      >
                        {e.fullName}
                      </Link>
                      <p className="text-xs text-slate-500 sm:hidden">{e.accountNumber}</p>
                      <p className="hidden text-xs text-slate-500 sm:block">
                        {e.position?.title ?? '—'}
                      </p>
                    </td>
                    <td className="hidden px-4 py-3 font-mono text-xs sm:table-cell">
                      {e.accountNumber}
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">{e.department?.name ?? '—'}</td>
                    <td className="hidden px-4 py-3 lg:table-cell">{e.role?.name ?? '—'}</td>
                    <td className="px-4 py-3">
                      {e.accountStatus ? (
                        <Badge tone={ACCOUNT_STATUS[e.accountStatus].tone}>
                          {ACCOUNT_STATUS[e.accountStatus].label}
                        </Badge>
                      ) : (
                        <Badge>No account</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={list.data.meta.total}
            onPage={(p) => update({ page: String(p) })}
          />
        </>
      )}
    </>
  );
}
