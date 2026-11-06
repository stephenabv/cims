import {
  APPROVAL_STEP_KINDS,
  type ApprovalChainStepInput,
  type ApprovalChainView,
  type LeaveTypeView,
  approvalChainSchema,
  leaveTypeSchema,
} from '@cims/shared';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/SelectField';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { useCorrectionSettings, useSaveCorrectionSettings } from '../corrections/api';
import { useEmployees } from '../employees/api';
import {
  useAllLeaveTypes,
  useApprovalChains,
  useApproverRoles,
  useEmployeeBalances,
  useSaveApprovalChain,
  useSaveLeaveType,
  useSetLeaveBalance,
} from './api';
import { STEP_KIND } from './labels';

/** HR configuration of leave types, approval chains and yearly allotments (spec §3.3, Q-1). */
export function LeaveSettingsPage() {
  return (
    <>
      <PageHeader
        title="Leave settings"
        description="Leave types, who approves them, and optional yearly allotments."
      />
      <div className="grid gap-6">
        <TypesCard />
        <ChainsCard />
        <CorrectionApprovalCard />
        <BalancesCard />
      </div>
    </>
  );
}

function issuesToErrors(
  issues: { path: PropertyKey[]; message: string }[],
): Record<string, string> {
  const fe: Record<string, string> = {};
  for (const i of issues) fe[i.path.map(String).join('.')] ??= i.message;
  return fe;
}

// ── Types ─────────────────────────────────────────────────────────────────────

function TypesCard() {
  const types = useAllLeaveTypes();
  const chains = useApprovalChains();
  const [editing, setEditing] = useState<LeaveTypeView | 'new' | null>(null);
  const chainName = (id: string | null) =>
    id ? (chains.data?.find((c) => c.id === id)?.name ?? '…') : 'Default chain';
  return (
    <Card
      title="Leave types"
      description="Inactive types stay on existing requests but cannot be applied for."
    >
      {types.isError ? (
        <Alert tone="error">{errorMessage(types.error)}</Alert>
      ) : types.isPending ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {types.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0 text-sm">
                <span className="font-mono text-xs text-slate-500">{t.code}</span>{' '}
                <span className="font-medium">{t.name}</span>{' '}
                <Badge tone={t.isPaid ? 'success' : 'neutral'}>
                  {t.isPaid ? 'Paid' : 'Unpaid'}
                </Badge>{' '}
                {!t.isActive && <Badge tone="danger">Inactive</Badge>}
                <p className="text-xs text-slate-500">Approvals: {chainName(t.approvalChainId)}</p>
              </div>
              <Button variant="ghost" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button className="mt-3" variant="secondary" onClick={() => setEditing('new')}>
        Add leave type
      </Button>
      {editing && (
        <TypeDialog
          type={editing === 'new' ? null : editing}
          chains={chains.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function TypeDialog({
  type,
  chains,
  onClose,
}: {
  type: LeaveTypeView | null;
  chains: ApprovalChainView[];
  onClose: () => void;
}) {
  const save = useSaveLeaveType();
  const [form, setForm] = useState({
    code: type?.code ?? '',
    name: type?.name ?? '',
    isPaid: type?.isPaid ?? true,
    isActive: type?.isActive ?? true,
    approvalChainId: type?.approvalChainId ?? null,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  return (
    <Dialog open onClose={onClose} title={type ? `Edit ${type.name}` : 'Add leave type'}>
      <form
        noValidate
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = leaveTypeSchema.safeParse(form);
          if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues));
          setErrors({});
          save.mutate(
            { id: type?.id ?? null, body: parsed.data },
            {
              onSuccess: onClose,
              onError: (err) => {
                const fe = err instanceof ApiError ? err.fieldErrors() : {};
                if (Object.keys(fe).length) setErrors(fe);
                else setFormError(errorMessage(err));
              },
            },
          );
        }}
      >
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
          <TextField
            label="Code"
            value={form.code}
            maxLength={20}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            error={errors.code}
          />
          <TextField
            label="Name"
            value={form.name}
            maxLength={100}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            error={errors.name}
          />
        </div>
        <SelectField
          label="Approval chain"
          value={form.approvalChainId ?? ''}
          onChange={(e) => setForm({ ...form, approvalChainId: e.target.value || null })}
          options={[
            { value: '', label: 'Default chain' },
            ...chains.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isPaid}
            onChange={(e) => setForm({ ...form, isPaid: e.target.checked })}
            className="size-4"
          />
          Paid (counts as paid hours in payroll)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            className="size-4"
          />
          Employees can apply for it
        </label>
        {formError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {formError}
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

// ── Attendance corrections ────────────────────────────────────────────────────

/** Which approval chain attendance correction requests follow (defaults to the default chain). */
function CorrectionApprovalCard() {
  const chains = useApprovalChains();
  const settings = useCorrectionSettings(true);
  const save = useSaveCorrectionSettings();
  const [value, setValue] = useState<string | null>(null);
  const current = value ?? settings.data?.approvalChainId ?? '';

  return (
    <Card
      title="Attendance correction approvals"
      description="The approval chain employees' attendance correction requests follow. Changes apply to new requests only."
    >
      {chains.isError || settings.isError ? (
        <Alert tone="error">{errorMessage(chains.error ?? settings.error)}</Alert>
      ) : chains.isPending || settings.isPending ? (
        <Spinner />
      ) : (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(current || null, { onSuccess: () => setValue(null) });
          }}
        >
          <div className="min-w-64 flex-1">
            <SelectField
              label="Approval chain"
              value={current}
              onChange={(e) => setValue(e.target.value)}
              options={[
                { value: '', label: 'Default chain' },
                ...chains.data.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </div>
          <Button type="submit" loading={save.isPending} disabled={value === null}>
            Save
          </Button>
          {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        </form>
      )}
    </Card>
  );
}

// ── Chains ────────────────────────────────────────────────────────────────────

function ChainsCard() {
  const chains = useApprovalChains();
  const [editing, setEditing] = useState<ApprovalChainView | 'new' | null>(null);
  return (
    <Card
      title="Approval chains"
      description="Approvers act in order. A step that cannot be resolved (for example, no supervisor) is skipped; if none are left, HR approves. Changes apply to new requests only."
    >
      {chains.isError ? (
        <Alert tone="error">{errorMessage(chains.error)}</Alert>
      ) : chains.isPending ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {chains.data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0 text-sm">
                <span className="font-medium">{c.name}</span>{' '}
                {c.isDefault && <Badge tone="info">Default</Badge>}
                <p className="text-xs text-slate-500">
                  {c.steps
                    .map((s) => s.roleName ?? s.employeeName ?? STEP_KIND[s.kind])
                    .join(' → ')}
                </p>
              </div>
              <Button variant="ghost" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button className="mt-3" variant="secondary" onClick={() => setEditing('new')}>
        Add approval chain
      </Button>
      {editing && (
        <ChainDialog chain={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </Card>
  );
}

function ChainDialog({ chain, onClose }: { chain: ApprovalChainView | null; onClose: () => void }) {
  const save = useSaveApprovalChain();
  const roles = useApproverRoles();
  const people = useEmployees({ pageSize: 100 });
  const [name, setName] = useState(chain?.name ?? '');
  const [steps, setSteps] = useState<ApprovalChainStepInput[]>(
    chain?.steps.map((s) => ({ kind: s.kind, roleId: s.roleId, employeeId: s.employeeId })) ?? [
      { kind: 'SUPERVISOR', roleId: null, employeeId: null },
    ],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const update = (i: number, patch: Partial<ApprovalChainStepInput>) =>
    setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <Dialog open onClose={onClose} title={chain ? `Edit ${chain.name}` : 'Add approval chain'}>
      <form
        noValidate
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = approvalChainSchema.safeParse({ name, steps });
          if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues));
          setErrors({});
          save.mutate(
            { id: chain?.id ?? null, body: parsed.data },
            {
              onSuccess: onClose,
              onError: (err) => {
                const fe = err instanceof ApiError ? err.fieldErrors() : {};
                if (Object.keys(fe).length) setErrors(fe);
                else setFormError(errorMessage(err));
              },
            },
          );
        }}
      >
        <TextField
          label="Name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
        />
        <ol className="grid gap-3">
          {steps.map((s, i) => (
            <li
              key={i}
              className="grid gap-2 rounded-lg p-3 ring-1 ring-slate-200 dark:ring-slate-700"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Approver {i + 1}</span>
                {steps.length > 1 && (
                  <Button
                    variant="ghost"
                    className="min-h-8 px-2 py-1 text-xs"
                    onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}
                    aria-label={`Remove approver ${i + 1}`}
                  >
                    Remove
                  </Button>
                )}
              </div>
              <SelectField
                label="Who approves"
                value={s.kind}
                onChange={(e) =>
                  update(i, {
                    kind: e.target.value as ApprovalChainStepInput['kind'],
                    roleId: null,
                    employeeId: null,
                  })
                }
                options={APPROVAL_STEP_KINDS.map((k) => ({ value: k, label: STEP_KIND[k] }))}
              />
              {s.kind === 'ROLE' && (
                <SelectField
                  label="Role"
                  value={s.roleId ?? ''}
                  onChange={(e) => update(i, { roleId: e.target.value || null })}
                  placeholder="Choose…"
                  options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
                  error={errors[`steps.${i}.roleId`]}
                />
              )}
              {s.kind === 'EMPLOYEE' && (
                <SelectField
                  label="Person"
                  value={s.employeeId ?? ''}
                  onChange={(e) => update(i, { employeeId: e.target.value || null })}
                  placeholder="Choose…"
                  options={(people.data?.data ?? []).map((p) => ({
                    value: p.id,
                    label: `${p.fullName} (${p.accountNumber})`,
                  }))}
                  error={errors[`steps.${i}.employeeId`]}
                />
              )}
            </li>
          ))}
        </ol>
        {errors.steps && <p className="text-sm text-red-600">{errors.steps}</p>}
        {steps.length < 5 && (
          <div>
            <Button
              variant="secondary"
              onClick={() =>
                setSteps((x) => [...x, { kind: 'ROLE', roleId: null, employeeId: null }])
              }
            >
              Add approver
            </Button>
          </div>
        )}
        {formError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {formError}
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

// ── Balances ──────────────────────────────────────────────────────────────────

function BalancesCard() {
  const [search, setSearch] = useState('');
  const people = useEmployees({ search: search || undefined, pageSize: 20 });
  const [employeeId, setEmployeeId] = useState('');
  const [year, setYear] = useState(new Date().getFullYear());
  const balances = useEmployeeBalances(employeeId || undefined, year);
  return (
    <Card
      title="Yearly allotments"
      description="Optional. Leave a type blank for no limit. Pending and approved days count against the allotment."
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem]">
        <TextField
          label="Find employee"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or account number"
        />
        <SelectField
          label="Employee"
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          placeholder="Choose…"
          options={(people.data?.data ?? []).map((p) => ({
            value: p.id,
            label: `${p.fullName} (${p.accountNumber})`,
          }))}
        />
        <TextField
          label="Year"
          type="number"
          value={year}
          min={2000}
          max={2100}
          onChange={(e) => setYear(Number(e.target.value) || new Date().getFullYear())}
        />
      </div>
      {employeeId &&
        (balances.isError ? (
          <Alert tone="error">{errorMessage(balances.error)}</Alert>
        ) : balances.isPending ? (
          <Spinner />
        ) : (
          <ul className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
            {balances.data.map((b) => (
              <BalanceRow
                key={`${employeeId}-${year}-${b.leaveType.id}`}
                employeeId={employeeId}
                year={year}
                balance={b}
              />
            ))}
          </ul>
        ))}
    </Card>
  );
}

function BalanceRow({
  employeeId,
  year,
  balance: b,
}: {
  employeeId: string;
  year: number;
  balance: NonNullable<ReturnType<typeof useEmployeeBalances>['data']>[number];
}) {
  const save = useSetLeaveBalance();
  const [value, setValue] = useState(b.allottedDays === null ? '' : String(b.allottedDays));
  const [error, setError] = useState<string>();
  const dirty = value !== (b.allottedDays === null ? '' : String(b.allottedDays));
  return (
    <li className="flex flex-wrap items-end justify-between gap-3 py-3">
      <div className="min-w-0 text-sm">
        <p className="font-medium">{b.leaveType.name}</p>
        <p className="text-xs text-slate-500">
          {b.approvedDays} approved · {b.pendingDays} pending
          {b.remainingDays !== null && ` · ${b.remainingDays} left`}
        </p>
      </div>
      <form
        noValidate
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const days = value.trim() === '' ? null : Number(value);
          if (days !== null && (!Number.isInteger(days) || days < 0 || days > 366))
            return setError('0–366 days');
          setError(undefined);
          save.mutate(
            { employeeId, leaveTypeId: b.leaveType.id, year, allottedDays: days },
            { onError: (err) => setError(errorMessage(err)) },
          );
        }}
      >
        <TextField
          label={`${b.leaveType.name} days`}
          className="w-28"
          type="number"
          min={0}
          max={366}
          value={value}
          placeholder="No limit"
          onChange={(e) => setValue(e.target.value)}
          error={error}
        />
        <Button type="submit" variant="secondary" disabled={!dirty} loading={save.isPending}>
          Save
        </Button>
      </form>
    </li>
  );
}
