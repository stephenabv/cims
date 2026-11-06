import {
  type CompensationOverview,
  type CompensationProfileView,
  type EmployeePayItemView,
  OVERTIME_RATE_KINDS,
  type OvertimeRateKind,
  PAY_SCHEDULES,
  type PayItemCalculation,
  type PaySchedule,
  PERMISSIONS,
} from '@cims/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loading, WithCompanyTimezone } from '@/components/PageState';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { errorMessage } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { formatWorkDate } from '@/lib/datetime';
import {
  formatMultiplier,
  formatPercent,
  formatPeso,
  parseMultiplier,
  parsePercent,
  parsePeso,
  pesoInput,
} from '@/lib/money';
import {
  useCompensation,
  useCompensationMutations,
  usePayItemTypes,
  useUndertimePolicies,
} from './api';
import { ConfirmDialog, DialogActions, FormError, SectionHeader, serverErrors } from './parts';
import { ITEM_DIRECTION, PAY_SCHEDULE } from './labels';
import { PayPreviewSection } from './PayPreviewSection';

const OVERTIME_KIND: Record<OvertimeRateKind, string> = {
  MULTIPLIER: 'Multiple of the hourly rate',
  FIXED: 'Fixed overtime hourly rate',
};

const sectionClass =
  'mt-6 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:p-6 dark:bg-slate-900 dark:ring-slate-800';

/** One employee's pay terms, allowances and deductions, with a live pay calculation (§3.4). */
export function EmployeeCompensationPage() {
  const { id = '' } = useParams();
  return (
    <WithCompanyTimezone>
      {(tz) => <EmployeeCompensation id={id} timezone={tz} />}
    </WithCompanyTimezone>
  );
}

function EmployeeCompensation({ id, timezone }: { id: string; timezone: string }) {
  const { can, user } = useAuth();
  const overview = useCompensation(id);
  if (overview.isError) return <Alert tone="error">{errorMessage(overview.error)}</Alert>;
  if (overview.isPending) return <Loading />;
  const { employee } = overview.data;
  // The server refuses changes to one's own pay; hiding the controls just avoids a dead end.
  const canEdit = can(PERMISSIONS.COMPENSATION_EDIT) && user?.employeeId !== employee.id;

  return (
    <>
      <p className="mb-2 text-sm">
        <Link
          to="/app/payroll/employees"
          className="text-brand-700 hover:underline dark:text-brand-100"
        >
          ← Pay setup
        </Link>
      </p>
      <PageHeader
        title={employee.fullName}
        description={[employee.accountNumber, employee.department, employee.position]
          .filter(Boolean)
          .join(' · ')}
      />
      {can(PERMISSIONS.COMPENSATION_EDIT) && !canEdit && (
        <Alert tone="info">
          You can view your own pay here, but someone else has to change it.
        </Alert>
      )}
      <PayTermsSection overview={overview.data} canEdit={canEdit} />
      <PayItemsSection overview={overview.data} canEdit={canEdit} />
      <PayPreviewSection employeeId={employee.id} timezone={timezone} />
    </>
  );
}

// ── Pay terms ────────────────────────────────────────────────────────────────

function PayTermsSection({
  overview,
  canEdit,
}: {
  overview: CompensationOverview;
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<CompensationProfileView | null>(null);
  const mutations = useCompensationMutations(overview.employee.id);
  const current = overview.profiles.find((p) => p.isCurrent) ?? null;

  return (
    <section className={sectionClass} aria-labelledby="pay-terms">
      <SectionHeader
        id="pay-terms"
        title="Pay terms"
        description="Each change starts on a date; earlier periods keep the terms that applied then."
        action={
          canEdit && (
            <Button onClick={() => setAdding(true)}>
              {current ? 'Change pay terms' : 'Set pay terms'}
            </Button>
          )
        }
      />
      {overview.profiles.length === 0 ? (
        <EmptyState
          title="No pay terms yet"
          description="This employee is not paid until an hourly rate is set."
        />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {overview.profiles.map((p) => (
            <li key={p.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium tabular-nums">
                  {formatPeso(p.hourlyRateCentavos)}/h
                  {p.isCurrent ? (
                    <Badge tone="success">Current</Badge>
                  ) : p.canRemove ? (
                    <Badge tone="info">Scheduled</Badge>
                  ) : (
                    <Badge>Past</Badge>
                  )}
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  From {formatWorkDate(p.effectiveFrom, { year: true })} ·{' '}
                  {PAY_SCHEDULE[p.paySchedule]}
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Overtime{' '}
                  {p.overtimeRateKind === 'MULTIPLIER'
                    ? `${formatMultiplier(p.overtimeMultiplierPermille ?? 1000)} the hourly rate`
                    : `${formatPeso(p.overtimeFixedRateCentavos ?? 0)}/h`}{' '}
                  · Late and undertime: {p.undertimePolicy.name}
                </p>
                {p.note && (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{p.note}</p>
                )}
              </div>
              {canEdit && p.canRemove && (
                <Button variant="secondary" onClick={() => setRemoving(p)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <ProfileDialog
          employeeId={overview.employee.id}
          current={current}
          onClose={() => setAdding(false)}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="Remove scheduled pay terms?"
          confirmLabel="Remove"
          pending={mutations.removeProfile.isPending}
          error={mutations.removeProfile.error}
          onClose={() => {
            mutations.removeProfile.reset();
            setRemoving(null);
          }}
          onConfirm={() =>
            mutations.removeProfile.mutate(removing.id, { onSuccess: () => setRemoving(null) })
          }
        >
          The {formatPeso(removing.hourlyRateCentavos)}/h terms starting{' '}
          {formatWorkDate(removing.effectiveFrom, { year: true })} will not take effect.
        </ConfirmDialog>
      )}
    </section>
  );
}

function ProfileDialog({
  employeeId,
  current,
  onClose,
}: {
  employeeId: string;
  current: CompensationProfileView | null;
  onClose: () => void;
}) {
  const policies = useUndertimePolicies();
  const { addProfile } = useCompensationMutations(employeeId);
  const activePolicies = (policies.data ?? []).filter((p) => p.isActive);
  const defaultPolicy = activePolicies.find((p) => p.isDefault) ?? activePolicies[0];
  const [form, setForm] = useState({
    effectiveFrom: '',
    hourlyRate: current ? pesoInput(current.hourlyRateCentavos) : '',
    paySchedule: (current?.paySchedule ?? 'SEMI_MONTHLY') as PaySchedule,
    overtimeRateKind: (current?.overtimeRateKind ?? 'MULTIPLIER') as OvertimeRateKind,
    multiplier: formatMultiplier(current?.overtimeMultiplierPermille ?? 1250).replace('×', ''),
    overtimeRate: current?.overtimeFixedRateCentavos
      ? pesoInput(current.overtimeFixedRateCentavos)
      : '',
    undertimePolicyId: current?.undertimePolicy.id ?? '',
    note: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const policyId = form.undertimePolicyId || defaultPolicy?.id || '';

  const submit = () => {
    const next: Record<string, string> = {};
    const hourly = parsePeso(form.hourlyRate);
    const multiplier = parseMultiplier(form.multiplier);
    const fixed = parsePeso(form.overtimeRate);
    if (!form.effectiveFrom) next.effectiveFrom = 'Pick the first day these terms apply';
    if (!hourly) next.hourlyRateCentavos = 'Enter an amount such as 125.50';
    if (
      form.overtimeRateKind === 'MULTIPLIER' &&
      (!multiplier || multiplier < 1000 || multiplier > 5000)
    )
      next.overtimeMultiplierPermille = 'Enter a multiplier from 1 to 5, such as 1.25';
    if (form.overtimeRateKind === 'FIXED' && !fixed)
      next.overtimeFixedRateCentavos = 'Enter an amount such as 150';
    if (!policyId) next.undertimePolicyId = 'Pick a policy';
    setErrors(next);
    if (Object.keys(next).length) return;
    addProfile.mutate(
      {
        effectiveFrom: form.effectiveFrom,
        hourlyRateCentavos: hourly!,
        paySchedule: form.paySchedule,
        overtimeRateKind: form.overtimeRateKind,
        overtimeMultiplierPermille: form.overtimeRateKind === 'MULTIPLIER' ? multiplier : null,
        overtimeFixedRateCentavos: form.overtimeRateKind === 'FIXED' ? fixed : null,
        undertimePolicyId: policyId,
        note: form.note.trim() || undefined,
      },
      { onSuccess: onClose, onError: (err) => setErrors(serverErrors(err)) },
    );
  };

  return (
    <Dialog open onClose={onClose} title={current ? 'Change pay terms' : 'Set pay terms'}>
      <form
        noValidate
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Applies from"
          type="date"
          value={form.effectiveFrom}
          onChange={set('effectiveFrom')}
          error={errors.effectiveFrom}
          hint="Past dates change pay already calculated for those days."
        />
        <TextField
          label="Hourly rate (₱)"
          inputMode="decimal"
          value={form.hourlyRate}
          onChange={set('hourlyRate')}
          error={errors.hourlyRateCentavos}
        />
        <SelectField
          label="Pay schedule"
          value={form.paySchedule}
          onChange={set('paySchedule')}
          error={errors.paySchedule}
          options={PAY_SCHEDULES.map((s) => ({ value: s, label: PAY_SCHEDULE[s] }))}
        />
        <SelectField
          label="Overtime pay"
          value={form.overtimeRateKind}
          onChange={set('overtimeRateKind')}
          options={OVERTIME_RATE_KINDS.map((k) => ({ value: k, label: OVERTIME_KIND[k] }))}
        />
        {form.overtimeRateKind === 'MULTIPLIER' ? (
          <TextField
            label="Overtime multiplier"
            inputMode="decimal"
            value={form.multiplier}
            onChange={set('multiplier')}
            error={errors.overtimeMultiplierPermille}
            hint="1.25 pays overtime at 125% of the hourly rate."
          />
        ) : (
          <TextField
            label="Overtime hourly rate (₱)"
            inputMode="decimal"
            value={form.overtimeRate}
            onChange={set('overtimeRate')}
            error={errors.overtimeFixedRateCentavos}
          />
        )}
        <SelectField
          label="Late and undertime policy"
          value={policyId}
          onChange={set('undertimePolicyId')}
          error={errors.undertimePolicyId}
          options={activePolicies.map((p) => ({
            value: p.id,
            label: p.isDefault ? `${p.name} (default)` : p.name,
          }))}
        />
        <TextField
          label="Note (optional)"
          value={form.note}
          onChange={set('note')}
          maxLength={500}
        />
        <FormError message={errors.form} />
        <DialogActions onCancel={onClose} pending={addProfile.isPending} label="Save" />
      </form>
    </Dialog>
  );
}

// ── Allowances and deductions ────────────────────────────────────────────────

function itemAmount(i: EmployeePayItemView): string {
  return i.calculation === 'FIXED'
    ? `${formatPeso(i.amountCentavos ?? 0)} per payroll`
    : `${formatPercent(i.rateBasisPoints ?? 0)} of earned pay`;
}

function PayItemsSection({
  overview,
  canEdit,
}: {
  overview: CompensationOverview;
  canEdit: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<EmployeePayItemView | null>(null);
  const [removing, setRemoving] = useState<EmployeePayItemView | null>(null);
  const { removeItem } = useCompensationMutations(overview.employee.id);

  return (
    <section className={sectionClass} aria-labelledby="pay-items">
      <SectionHeader
        id="pay-items"
        title="Allowances and deductions"
        description="Recurring amounts added to or taken from each payroll, including government contributions and tax."
        action={canEdit && <Button onClick={() => setAdding(true)}>Add</Button>}
      />
      {overview.items.length === 0 ? (
        <EmptyState title="None set up" description="Only time-based pay applies." />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {overview.items.map((i) => (
            <li key={i.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {i.type.name}
                  <Badge tone={i.type.direction === 'ALLOWANCE' ? 'success' : 'neutral'}>
                    {ITEM_DIRECTION[i.type.direction]}
                  </Badge>
                  {!i.isActive && (
                    <Badge tone={i.canRemove ? 'info' : 'neutral'}>
                      {i.canRemove ? 'Scheduled' : 'Ended'}
                    </Badge>
                  )}
                </p>
                <p className="text-sm text-slate-600 tabular-nums dark:text-slate-400">
                  {itemAmount(i)}
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {formatWorkDate(i.effectiveFrom, { year: true })} –{' '}
                  {i.effectiveTo ? formatWorkDate(i.effectiveTo, { year: true }) : 'no end date'}
                </p>
                {i.note && (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{i.note}</p>
                )}
              </div>
              {canEdit && (
                <div className="flex gap-2">
                  {i.canRemove ? (
                    <Button variant="secondary" onClick={() => setRemoving(i)}>
                      Remove
                    </Button>
                  ) : (
                    i.isActive && (
                      <Button variant="secondary" onClick={() => setEnding(i)}>
                        End
                      </Button>
                    )
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <ItemDialog employeeId={overview.employee.id} onClose={() => setAdding(false)} />}
      {ending && (
        <EndItemDialog
          employeeId={overview.employee.id}
          item={ending}
          onClose={() => setEnding(null)}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.type.name}?`}
          confirmLabel="Remove"
          pending={removeItem.isPending}
          error={removeItem.error}
          onClose={() => {
            removeItem.reset();
            setRemoving(null);
          }}
          onConfirm={() => removeItem.mutate(removing.id, { onSuccess: () => setRemoving(null) })}
        >
          It has not started yet, so it will be removed without affecting any payroll.
        </ConfirmDialog>
      )}
    </section>
  );
}

function ItemDialog({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const types = usePayItemTypes();
  const { addItem } = useCompensationMutations(employeeId);
  const active = (types.data ?? []).filter((t) => t.isActive);
  const [form, setForm] = useState({
    typeId: '',
    calculation: 'FIXED' as PayItemCalculation,
    amount: '',
    percent: '',
    effectiveFrom: '',
    effectiveTo: '',
    note: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const type = active.find((t) => t.id === form.typeId);
  // Allowances are always fixed amounts (A-13); only deductions can be a percentage.
  const calculation: PayItemCalculation =
    type?.direction === 'DEDUCTION' ? form.calculation : 'FIXED';

  const submit = () => {
    const next: Record<string, string> = {};
    const amount = parsePeso(form.amount);
    const percent = parsePercent(form.percent);
    if (!type) next.typeId = 'Pick what this is';
    if (calculation === 'FIXED' && !amount) next.amountCentavos = 'Enter an amount such as 500';
    if (calculation === 'PERCENT_OF_GROSS' && (!percent || percent > 10_000))
      next.rateBasisPoints = 'Enter a percentage from 0.01 to 100, such as 4.5';
    if (!form.effectiveFrom) next.effectiveFrom = 'Pick the first day it applies';
    if (form.effectiveTo && form.effectiveFrom && form.effectiveTo < form.effectiveFrom)
      next.effectiveTo = 'End date must be on or after the start date';
    setErrors(next);
    if (Object.keys(next).length) return;
    addItem.mutate(
      {
        typeId: type!.id,
        calculation,
        amountCentavos: calculation === 'FIXED' ? amount : null,
        rateBasisPoints: calculation === 'PERCENT_OF_GROSS' ? percent : null,
        effectiveFrom: form.effectiveFrom,
        effectiveTo: form.effectiveTo || null,
        note: form.note.trim() || undefined,
      },
      { onSuccess: onClose, onError: (err) => setErrors(serverErrors(err)) },
    );
  };

  return (
    <Dialog open onClose={onClose} title="Add allowance or deduction">
      <form
        noValidate
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <SelectField
          label="Type"
          placeholder="Choose…"
          value={form.typeId}
          onChange={set('typeId')}
          error={errors.typeId}
          options={active.map((t) => ({
            value: t.id,
            label: `${t.name} (${ITEM_DIRECTION[t.direction].toLowerCase()})`,
          }))}
        />
        {type?.direction === 'DEDUCTION' && (
          <SelectField
            label="Calculated as"
            value={form.calculation}
            onChange={set('calculation')}
            options={[
              { value: 'FIXED', label: 'Fixed amount per payroll' },
              { value: 'PERCENT_OF_GROSS', label: 'Percentage of earned pay' },
            ]}
          />
        )}
        {calculation === 'FIXED' ? (
          <TextField
            label="Amount per payroll (₱)"
            inputMode="decimal"
            value={form.amount}
            onChange={set('amount')}
            error={errors.amountCentavos}
          />
        ) : (
          <TextField
            label="Percentage"
            inputMode="decimal"
            value={form.percent}
            onChange={set('percent')}
            error={errors.rateBasisPoints}
            hint="Of pay earned in the period, after late and undertime deductions."
          />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="From"
            type="date"
            value={form.effectiveFrom}
            onChange={set('effectiveFrom')}
            error={errors.effectiveFrom}
          />
          <TextField
            label="Until (optional)"
            type="date"
            value={form.effectiveTo}
            min={form.effectiveFrom || undefined}
            onChange={set('effectiveTo')}
            error={errors.effectiveTo}
          />
        </div>
        <TextField
          label="Note (optional)"
          value={form.note}
          onChange={set('note')}
          maxLength={500}
        />
        <FormError message={errors.form} />
        <DialogActions onCancel={onClose} pending={addItem.isPending} label="Add" />
      </form>
    </Dialog>
  );
}

function EndItemDialog({
  employeeId,
  item,
  onClose,
}: {
  employeeId: string;
  item: EmployeePayItemView;
  onClose: () => void;
}) {
  const { endItem } = useCompensationMutations(employeeId);
  const [effectiveTo, setEffectiveTo] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  return (
    <Dialog open onClose={onClose} title={`End ${item.type.name}`}>
      <form
        noValidate
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!effectiveTo) return setErrors({ effectiveTo: 'Pick the last day it applies' });
          endItem.mutate(
            { id: item.id, body: { effectiveTo, version: item.version } },
            { onSuccess: onClose, onError: (err) => setErrors(serverErrors(err)) },
          );
        }}
      >
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {itemAmount(item)} since {formatWorkDate(item.effectiveFrom, { year: true })}.
        </p>
        <TextField
          label="Last day it applies"
          type="date"
          min={item.effectiveFrom}
          value={effectiveTo}
          onChange={(e) => setEffectiveTo(e.target.value)}
          error={errors.effectiveTo}
        />
        <FormError message={errors.form ?? errors.version} />
        <DialogActions onCancel={onClose} pending={endItem.isPending} label="End" />
      </form>
    </Dialog>
  );
}
