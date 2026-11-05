import {
  type EmployeeDetail,
  type LifecycleAction,
  employmentDetailsSchema,
  personalDetailsSchema,
} from '@cims/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { type ReactNode, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useParams } from 'react-router-dom';
import { z } from 'zod';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/SelectField';
import { FullPageSpinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import {
  useAssignableRoles,
  useChangeRole,
  useCredentialReset,
  useDepartments,
  useEmployee,
  useEmployeeHistory,
  useEmployees,
  useLifecycle,
  usePositions,
  useUpdateEmployment,
  useUpdatePersonal,
} from './api';
import {
  ACCOUNT_STATUS,
  CLASSIFICATION_LABELS,
  EMPLOYMENT_STATUS_LABELS,
  FIELD_LABELS,
  toOptions,
} from './labels';

export function EmployeeDetailPage() {
  const { id = '' } = useParams();
  return <EmployeeDetailLoader id={id} />;
}

export function MyProfilePage() {
  return <EmployeeDetailLoader id="me" />;
}

function EmployeeDetailLoader({ id }: { id: string }) {
  const query = useEmployee(id);
  if (query.isPending) return <FullPageSpinner />;
  if (query.isError) return <Alert tone="error">{errorMessage(query.error)}</Alert>;
  return <EmployeeDetailView employee={query.data} />;
}

function EmployeeDetailView({ employee }: { employee: EmployeeDetail }) {
  const location = useLocation();
  const state = location.state as { provisioned?: boolean; credentialsDelivered?: boolean } | null;
  const status = employee.accountStatus ? ACCOUNT_STATUS[employee.accountStatus] : null;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          to="/app/employees"
          className="text-sm text-brand-700 hover:underline dark:text-brand-100"
        >
          ← Employees
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{employee.fullName}</h1>
          {status && <Badge tone={status.tone}>{status.label}</Badge>}
        </div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          <span className="font-mono">{employee.accountNumber}</span> ·{' '}
          {employee.position?.title ?? 'No position'} ·{' '}
          {employee.department?.name ?? 'No department'}
        </p>
      </div>
      {state?.provisioned && (
        <Alert tone={state.credentialsDelivered ? 'success' : 'warning'} title="Employee created">
          {state.credentialsDelivered
            ? `Sign-in credentials and the attendance PIN were emailed to ${employee.companyEmail}.`
            : 'The welcome email could not be sent. Use “Send temporary password” and “Reset PIN” below to deliver credentials.'}
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <PersonalCard employee={employee} />
        <EmploymentCard employee={employee} />
        <AccountCard employee={employee} />
        <HistoryCard employee={employee} />
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-sm font-medium break-words">{children || '—'}</dd>
    </div>
  );
}

function applyFieldErrors(err: unknown, setError: (path: never, e: { message: string }) => void) {
  if (err instanceof ApiError)
    for (const [path, message] of Object.entries(err.fieldErrors()))
      setError(path as never, { message });
}

// ───────────── Personal ─────────────

function PersonalCard({ employee }: { employee: EmployeeDetail }) {
  const [editing, setEditing] = useState(false);
  const update = useUpdatePersonal(employee.id);
  const form = useForm({
    resolver: zodResolver(personalDetailsSchema),
    values: {
      contactNumber: employee.contactNumber ?? '',
      residentialAddress: employee.residentialAddress ?? '',
      emergencyContactName: employee.emergencyContactName ?? '',
      emergencyContactRelationship: employee.emergencyContactRelationship ?? '',
      emergencyContactPhone: employee.emergencyContactPhone ?? '',
    },
  });
  const errors = form.formState.errors;
  return (
    <Card title="Personal details">
      {editing ? (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit((v) =>
            update.mutate(
              { ...v, version: employee.version },
              {
                onSuccess: () => setEditing(false),
                onError: (e) => applyFieldErrors(e, form.setError),
              },
            ),
          )}
        >
          {update.isError && <Alert tone="error">{errorMessage(update.error)}</Alert>}
          <TextField
            label="Contact number"
            type="tel"
            error={errors.contactNumber?.message}
            {...form.register('contactNumber')}
          />
          <TextField
            label="Residential address"
            error={errors.residentialAddress?.message}
            {...form.register('residentialAddress')}
          />
          <TextField
            label="Emergency contact name"
            error={errors.emergencyContactName?.message}
            {...form.register('emergencyContactName')}
          />
          <TextField
            label="Relationship"
            error={errors.emergencyContactRelationship?.message}
            {...form.register('emergencyContactRelationship')}
          />
          <TextField
            label="Emergency contact phone"
            type="tel"
            error={errors.emergencyContactPhone?.message}
            {...form.register('emergencyContactPhone')}
          />
          <div className="flex gap-2">
            <Button type="submit" loading={update.isPending}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail label="Company email">{employee.companyEmail}</Detail>
            <Detail label="Contact number">{employee.contactNumber}</Detail>
            <Detail label="Residential address">{employee.residentialAddress}</Detail>
            <Detail label="Emergency contact">
              {employee.emergencyContactName &&
                `${employee.emergencyContactName}${employee.emergencyContactRelationship ? ` (${employee.emergencyContactRelationship})` : ''}`}
            </Detail>
            <Detail label="Emergency contact phone">{employee.emergencyContactPhone}</Detail>
          </dl>
          {employee.capabilities.editPersonal && (
            <Button variant="secondary" className="mt-4" onClick={() => setEditing(true)}>
              Edit personal details
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

// ───────────── Employment ─────────────

const employmentFormSchema = employmentDetailsSchema.extend({
  reason: z.string().trim().max(500).optional(),
});
const nullIfEmpty = (v: unknown) => (v === '' ? null : v);

function EmploymentCard({ employee }: { employee: EmployeeDetail }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card title="Employment">
      {editing ? (
        <EmploymentForm employee={employee} onDone={() => setEditing(false)} />
      ) : (
        <>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail label="Department">{employee.department?.name}</Detail>
            <Detail label="Position">{employee.position?.title}</Detail>
            <Detail label="Supervisor / approver">
              {employee.supervisor &&
                `${employee.supervisor.fullName} (${employee.supervisor.accountNumber})`}
            </Detail>
            <Detail label="Classification">{CLASSIFICATION_LABELS[employee.classification]}</Detail>
            <Detail label="Employment status">
              {EMPLOYMENT_STATUS_LABELS[employee.employmentStatus]}
            </Detail>
            <Detail label="Date hired">{employee.dateHired}</Detail>
          </dl>
          {employee.capabilities.editEmployment && (
            <Button variant="secondary" className="mt-4" onClick={() => setEditing(true)}>
              Edit employment details
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

function EmploymentForm({ employee, onDone }: { employee: EmployeeDetail; onDone: () => void }) {
  const departments = useDepartments();
  const positions = usePositions();
  const supervisors = useEmployees({ page: 1, pageSize: 100, accountStatus: 'ACTIVE' });
  const update = useUpdateEmployment(employee.id);
  const form = useForm({
    resolver: zodResolver(employmentFormSchema),
    defaultValues: {
      firstName: employee.firstName,
      middleName: employee.middleName ?? '',
      lastName: employee.lastName,
      suffix: employee.suffix ?? '',
      companyEmail: employee.companyEmail,
      departmentId: employee.department?.id ?? null,
      positionId: employee.position?.id ?? null,
      supervisorId: employee.supervisor?.id ?? null,
      classification: employee.classification,
      employmentStatus: employee.employmentStatus,
      dateHired: employee.dateHired,
      reason: '',
    },
  });
  const errors = form.formState.errors;
  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={form.handleSubmit(({ reason, ...v }) =>
        update.mutate(
          { ...v, reason: reason || undefined, version: employee.version },
          { onSuccess: onDone, onError: (e) => applyFieldErrors(e, form.setError) },
        ),
      )}
    >
      {update.isError && <Alert tone="error">{errorMessage(update.error)}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="First name"
          error={errors.firstName?.message}
          {...form.register('firstName')}
        />
        <TextField
          label="Last name"
          error={errors.lastName?.message}
          {...form.register('lastName')}
        />
        <TextField
          label="Middle name"
          error={errors.middleName?.message}
          {...form.register('middleName')}
        />
        <TextField label="Suffix" error={errors.suffix?.message} {...form.register('suffix')} />
      </div>
      <TextField
        label="Company email"
        type="email"
        error={errors.companyEmail?.message}
        {...form.register('companyEmail')}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Department"
          placeholder="No department"
          options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          {...form.register('departmentId', { setValueAs: nullIfEmpty })}
          error={errors.departmentId?.message}
        />
        <SelectField
          label="Position"
          placeholder="No position"
          options={(positions.data ?? []).map((p) => ({ value: p.id, label: p.title }))}
          {...form.register('positionId', { setValueAs: nullIfEmpty })}
          error={errors.positionId?.message}
        />
        <SelectField
          label="Supervisor / approver"
          placeholder="None"
          options={(supervisors.data?.data ?? [])
            .filter((e) => e.id !== employee.id)
            .map((e) => ({ value: e.id, label: `${e.fullName} (${e.accountNumber})` }))}
          {...form.register('supervisorId', { setValueAs: nullIfEmpty })}
          error={errors.supervisorId?.message}
        />
        <SelectField
          label="Classification"
          options={toOptions(CLASSIFICATION_LABELS)}
          {...form.register('classification')}
        />
        <SelectField
          label="Employment status"
          options={toOptions(EMPLOYMENT_STATUS_LABELS)}
          {...form.register('employmentStatus')}
        />
        <TextField
          label="Date hired"
          type="date"
          error={errors.dateHired?.message}
          {...form.register('dateHired')}
        />
      </div>
      <TextField
        label="Reason for change (recorded in history)"
        error={errors.reason?.message}
        {...form.register('reason')}
      />
      <div className="flex gap-2">
        <Button type="submit" loading={update.isPending}>
          Save
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ───────────── Account ─────────────

const LIFECYCLE_BY_STATUS: Record<
  string,
  { action: LifecycleAction; label: string; variant: 'primary' | 'secondary' | 'danger' }[]
> = {
  PENDING_ACTIVATION: [
    { action: 'activate', label: 'Activate', variant: 'primary' },
    { action: 'deactivate', label: 'Deactivate', variant: 'danger' },
  ],
  ACTIVE: [
    { action: 'suspend', label: 'Suspend', variant: 'secondary' },
    { action: 'deactivate', label: 'Deactivate', variant: 'danger' },
  ],
  SUSPENDED: [
    { action: 'reactivate', label: 'Reactivate', variant: 'primary' },
    { action: 'deactivate', label: 'Deactivate', variant: 'danger' },
  ],
  DEACTIVATED: [{ action: 'reactivate', label: 'Reactivate', variant: 'primary' }],
};

const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(500) });

function AccountCard({ employee }: { employee: EmployeeDetail }) {
  const caps = employee.capabilities;
  const [pending, setPending] = useState<{ action: LifecycleAction; label: string } | null>(null);
  const [roleOpen, setRoleOpen] = useState(false);
  const [resetKind, setResetKind] = useState<'temporary-password' | 'pin-reset' | null>(null);
  const lifecycle = useLifecycle(employee.id);
  const reset = useCredentialReset(employee.userId ?? '');
  const form = useForm({ resolver: zodResolver(reasonSchema), defaultValues: { reason: '' } });

  if (!employee.userId)
    return <Card title="System account">This employee has no system account.</Card>;
  const actions = employee.accountStatus ? (LIFECYCLE_BY_STATUS[employee.accountStatus] ?? []) : [];
  return (
    <Card title="System account">
      <dl className="grid gap-4 sm:grid-cols-2">
        <Detail label="Role">{employee.role?.name}</Detail>
        <Detail label="Account status">
          {employee.accountStatus && ACCOUNT_STATUS[employee.accountStatus].label}
        </Detail>
      </dl>
      {reset.isSuccess && (
        <div className="mt-4">
          <Alert tone="success">{reset.data.message}</Alert>
        </div>
      )}
      {(lifecycle.isError || reset.isError) && (
        <div className="mt-4">
          <Alert tone="error">{errorMessage(lifecycle.error ?? reset.error)}</Alert>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {caps.manageLifecycle &&
          actions.map((a) => (
            <Button key={a.action} variant={a.variant} onClick={() => setPending(a)}>
              {a.label}
            </Button>
          ))}
        {caps.changeRole && (
          <Button variant="secondary" onClick={() => setRoleOpen(true)}>
            Change role
          </Button>
        )}
        {caps.resetCredentials && (
          <>
            <Button variant="secondary" onClick={() => setResetKind('temporary-password')}>
              Send temporary password
            </Button>
            <Button variant="secondary" onClick={() => setResetKind('pin-reset')}>
              Reset PIN
            </Button>
          </>
        )}
      </div>

      <Dialog
        open={!!pending}
        onClose={() => setPending(null)}
        title={`${pending?.label ?? ''} account`}
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={form.handleSubmit(({ reason }) =>
            lifecycle.mutate(
              { action: pending!.action, reason },
              {
                onSettled: () => {
                  setPending(null);
                  form.reset();
                },
              },
            ),
          )}
        >
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {pending?.action === 'suspend' || pending?.action === 'deactivate'
              ? `${employee.fullName} will be signed out and will not be able to sign in or record attendance. Their records are kept.`
              : `${employee.fullName} will be able to sign in and record attendance.`}
          </p>
          <TextField
            label="Reason"
            error={form.formState.errors.reason?.message}
            {...form.register('reason')}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={pending?.action === 'deactivate' ? 'danger' : 'primary'}
              loading={lifecycle.isPending}
            >
              {pending?.label}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={!!resetKind}
        onClose={() => setResetKind(null)}
        title={resetKind === 'pin-reset' ? 'Reset attendance PIN' : 'Send temporary password'}
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {resetKind === 'pin-reset'
            ? `A new PIN will be emailed to ${employee.companyEmail}. The old PIN stops working immediately.`
            : `A temporary password will be emailed to ${employee.companyEmail}. ${employee.fullName} will be signed out everywhere and must choose a new password at next sign-in.`}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setResetKind(null)}>
            Cancel
          </Button>
          <Button
            loading={reset.isPending}
            onClick={() => reset.mutate(resetKind!, { onSettled: () => setResetKind(null) })}
          >
            Send
          </Button>
        </div>
      </Dialog>

      {roleOpen && <ChangeRoleDialog employee={employee} onClose={() => setRoleOpen(false)} />}
    </Card>
  );
}

const changeRoleFormSchema = z.object({
  roleId: z.string().uuid('Select a role'),
  reason: z.string().trim().min(3, 'Give a reason').max(500),
});

function ChangeRoleDialog({
  employee,
  onClose,
}: {
  employee: EmployeeDetail;
  onClose: () => void;
}) {
  const roles = useAssignableRoles();
  const change = useChangeRole(employee.id);
  const form = useForm({
    resolver: zodResolver(changeRoleFormSchema),
    defaultValues: { roleId: employee.role?.id ?? '', reason: '' },
  });
  return (
    <Dialog open onClose={onClose} title="Change role">
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={form.handleSubmit((v) => change.mutate(v, { onSuccess: onClose }))}
      >
        {change.isError && <Alert tone="error">{errorMessage(change.error)}</Alert>}
        <SelectField
          label="Role"
          options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
          error={form.formState.errors.roleId?.message}
          {...form.register('roleId')}
        />
        <TextField
          label="Reason"
          error={form.formState.errors.reason?.message}
          {...form.register('reason')}
        />
        <p className="text-xs text-slate-500">
          The employee will be signed out so the new permissions take effect.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={change.isPending}>
            Change role
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────── History ─────────────

function HistoryCard({ employee }: { employee: EmployeeDetail }) {
  const history = useEmployeeHistory(employee.id);
  return (
    <Card title="Change history" description="Every change to this record, newest first.">
      {history.isPending ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : history.isError ? (
        <Alert tone="error">{errorMessage(history.error)}</Alert>
      ) : history.data.length === 0 ? (
        <p className="text-sm text-slate-500">No changes recorded.</p>
      ) : (
        <ol className="flex max-h-96 flex-col gap-3 overflow-y-auto">
          {history.data.map((h) => (
            <li
              key={h.id}
              className="border-l-2 border-slate-200 pl-3 text-sm dark:border-slate-700"
            >
              <p className="font-medium">
                {FIELD_LABELS[h.field] ?? h.field}
                {h.field !== 'record' && (
                  <span className="font-normal text-slate-600 dark:text-slate-400">
                    {' '}
                    {h.oldValue ?? '—'} → {h.newValue ?? '—'}
                  </span>
                )}
                {h.field === 'record' && (
                  <span className="font-normal text-slate-600 dark:text-slate-400">
                    {' '}
                    {h.newValue}
                  </span>
                )}
              </p>
              <p className="text-xs text-slate-500">
                {new Date(h.createdAt).toLocaleString()} · {h.changedBy?.fullName ?? 'System'}
                {h.reason && ` · “${h.reason}”`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
