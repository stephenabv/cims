import { departmentSchema, positionSchema } from '@cims/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { ApiError, api, errorMessage } from '@/lib/api-client';
import { useDepartments, useEmployees, usePositions } from '../employees/api';

const nullIfEmpty = (v: unknown) => (v === '' ? null : v);

function useOrgMutation<T>(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: T }) =>
      api(id ? `${path}/${id}` : path, { method: id ? 'PATCH' : 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }),
  });
}

export function OrgPage() {
  return (
    <>
      <PageHeader
        title="Departments & positions"
        description="Reference data used in employee records. Department heads see their department's records and approvals."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <DepartmentsCard />
        <PositionsCard />
      </div>
    </>
  );
}

function DepartmentsCard() {
  const departments = useDepartments();
  const heads = useEmployees({ page: 1, pageSize: 100, accountStatus: 'ACTIVE' });
  const save = useOrgMutation<unknown>('/org/departments');
  const form = useForm({
    resolver: zodResolver(departmentSchema),
    defaultValues: { code: '', name: '', headId: null, isActive: true },
  });
  return (
    <Card title="Departments">
      <form
        noValidate
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={form.handleSubmit((body) =>
          save.mutate(
            { body },
            {
              onSuccess: () => form.reset(),
              onError: (e) =>
                e instanceof ApiError &&
                Object.entries(e.fieldErrors()).forEach(([p, m]) =>
                  form.setError(p as never, { message: m }),
                ),
            },
          ),
        )}
      >
        <TextField
          label="Code"
          placeholder="FIN"
          error={form.formState.errors.code?.message}
          {...form.register('code')}
        />
        <TextField
          label="Name"
          placeholder="Finance"
          error={form.formState.errors.name?.message}
          {...form.register('name')}
        />
        <SelectField
          label="Head (optional)"
          placeholder="None"
          className="sm:col-span-2"
          options={(heads.data?.data ?? []).map((e) => ({
            value: e.id,
            label: `${e.fullName} (${e.accountNumber})`,
          }))}
          error={form.formState.errors.headId?.message}
          {...form.register('headId', { setValueAs: nullIfEmpty })}
        />
        <div className="sm:col-span-2">
          <Button type="submit" loading={save.isPending}>
            Add department
          </Button>
        </div>
      </form>
      {save.isError &&
        !(save.error instanceof ApiError && save.error.code === 'VALIDATION_FAILED') && (
          <div className="mt-3">
            <Alert tone="error">{errorMessage(save.error)}</Alert>
          </div>
        )}
      <div className="mt-6">
        {departments.isError ? (
          <Alert tone="error">{errorMessage(departments.error)}</Alert>
        ) : departments.data?.length === 0 ? (
          <EmptyState title="No departments yet" />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {(departments.data ?? []).map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">
                    {d.name} <span className="font-mono text-xs text-slate-500">{d.code}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    {d.head ? `Head: ${d.head.fullName}` : 'No head'} · {d.employeeCount} employee
                    {d.employeeCount === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {!d.isActive && <Badge>Inactive</Badge>}
                  <Button
                    variant="ghost"
                    onClick={() => save.mutate({ id: d.id, body: { isActive: !d.isActive } })}
                  >
                    {d.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function PositionsCard() {
  const positions = usePositions();
  const departments = useDepartments();
  const save = useOrgMutation<unknown>('/org/positions');
  const form = useForm({
    resolver: zodResolver(positionSchema),
    defaultValues: { title: '', departmentId: null, isActive: true },
  });
  return (
    <Card title="Positions">
      <form
        noValidate
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={form.handleSubmit((body) =>
          save.mutate({ body }, { onSuccess: () => form.reset() }),
        )}
      >
        <TextField
          label="Title"
          placeholder="Accountant"
          error={form.formState.errors.title?.message}
          {...form.register('title')}
        />
        <SelectField
          label="Department (optional)"
          placeholder="Any department"
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          {...form.register('departmentId', { setValueAs: nullIfEmpty })}
        />
        <div className="sm:col-span-2">
          <Button type="submit" loading={save.isPending}>
            Add position
          </Button>
        </div>
      </form>
      {save.isError && (
        <div className="mt-3">
          <Alert tone="error">{errorMessage(save.error)}</Alert>
        </div>
      )}
      <ul className="mt-6 divide-y divide-slate-100 dark:divide-slate-800">
        {(positions.data ?? []).map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 py-3 text-sm">
            <div>
              <p className="font-medium">{p.title}</p>
              <p className="text-xs text-slate-500">{p.department?.name ?? 'Any department'}</p>
            </div>
            <div className="flex items-center gap-2">
              {!p.isActive && <Badge>Inactive</Badge>}
              <Button
                variant="ghost"
                onClick={() => save.mutate({ id: p.id, body: { isActive: !p.isActive } })}
              >
                {p.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {positions.data?.length === 0 && <EmptyState title="No positions yet" />}
    </Card>
  );
}
