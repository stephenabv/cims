import {
  PAY_ITEM_DIRECTIONS,
  type PayItemDirection,
  type PayItemTypeView,
  UNDERTIME_POLICY_KINDS,
  type UndertimePolicyKind,
  type UndertimePolicyView,
} from '@cims/shared';
import { useState } from 'react';
import { Loading } from '@/components/PageState';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { errorMessage } from '@/lib/api-client';
import { formatPeso, parsePeso, pesoInput } from '@/lib/money';
import { usePayItemTypes, usePayrollSetupMutations, useUndertimePolicies } from './api';
import { ITEM_DIRECTION, UNDERTIME_KIND } from './labels';
import { DialogActions, FormError, SectionHeader, serverErrors } from './parts';

const sectionClass =
  'mt-6 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:p-6 dark:bg-slate-900 dark:ring-slate-800';

/** How a policy prices late and undertime minutes, in words HR can check. */
export function describePolicy(p: UndertimePolicyView): string {
  switch (p.kind) {
    case 'HOURLY_EQUIVALENT':
      return 'Each minute is deducted at the employee’s hourly rate.';
    case 'FIXED_PER_BLOCK':
      return `${formatPeso(p.amountPerBlockCentavos ?? 0)} for every ${p.blockMinutes} minutes${
        p.chargePartialBlock
          ? ', counting a started block as a full one'
          : ', ignoring a partial block'
      }.`;
    case 'TIERED':
      return `${(p.tiers ?? [])
        .map((t) => `up to ${t.upToMinutes} min: ${formatPeso(t.amountCentavos)}`)
        .join('; ')}; beyond that, the hourly-rate equivalent.`;
  }
}

/** Company payroll rules: late and undertime policies, and kinds of allowances and deductions. */
export function PayrollSettingsPage() {
  return (
    <>
      <PageHeader
        title="Payroll settings"
        description="Rules shared by everyone's pay. Changes apply to pay calculated from now on."
      />
      <PoliciesSection />
      <ItemTypesSection />
    </>
  );
}

// ── Undertime policies ───────────────────────────────────────────────────────

function PoliciesSection() {
  const policies = useUndertimePolicies();
  const { makeDefault } = usePayrollSetupMutations();
  const [editing, setEditing] = useState<UndertimePolicyView | 'new' | null>(null);
  return (
    <section className={sectionClass} aria-labelledby="ut-policies">
      <SectionHeader
        id="ut-policies"
        title="Late and undertime policies"
        description="How late arrival and leaving early are deducted. Each employee's pay terms name one; new terms start with the default."
        action={<Button onClick={() => setEditing('new')}>Add policy</Button>}
      />
      {makeDefault.isError && <Alert tone="error">{errorMessage(makeDefault.error)}</Alert>}
      {policies.isError ? (
        <Alert tone="error">{errorMessage(policies.error)}</Alert>
      ) : policies.isPending ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {policies.data.map((p) => (
            <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {p.name}
                  {p.isDefault && <Badge tone="info">Default</Badge>}
                  {!p.isActive && <Badge>Inactive</Badge>}
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {UNDERTIME_KIND[p.kind]}
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400">{describePolicy(p)}</p>
              </div>
              <div className="flex gap-2">
                {!p.isDefault && p.isActive && (
                  <Button
                    variant="secondary"
                    loading={makeDefault.isPending && makeDefault.variables === p.id}
                    onClick={() => makeDefault.mutate(p.id)}
                  >
                    Make default
                  </Button>
                )}
                <Button variant="secondary" onClick={() => setEditing(p)}>
                  Edit
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <PolicyDialog
          policy={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

interface TierDraft {
  upTo: string;
  amount: string;
}

function PolicyDialog({
  policy,
  onClose,
}: {
  policy: UndertimePolicyView | null;
  onClose: () => void;
}) {
  const { savePolicy } = usePayrollSetupMutations();
  const [form, setForm] = useState({
    name: policy?.name ?? '',
    kind: (policy?.kind ?? 'HOURLY_EQUIVALENT') as UndertimePolicyKind,
    blockMinutes: policy?.blockMinutes ? String(policy.blockMinutes) : '',
    amountPerBlock: policy?.amountPerBlockCentavos ? pesoInput(policy.amountPerBlockCentavos) : '',
    chargePartialBlock: policy?.chargePartialBlock ?? true,
    isActive: policy?.isActive ?? true,
  });
  const [tiers, setTiers] = useState<TierDraft[]>(
    policy?.tiers?.map((t) => ({
      upTo: String(t.upToMinutes),
      amount: pesoInput(t.amountCentavos),
    })) ?? [{ upTo: '', amount: '' }],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set =
    (k: 'name' | 'kind' | 'blockMinutes' | 'amountPerBlock') =>
    (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));
  const minutes = (s: string) => {
    const n = Number(s);
    return s.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 480 ? n : null;
  };

  const submit = () => {
    const next: Record<string, string> = {};
    if (form.name.trim().length < 2) next.name = 'Enter a name';
    const block = minutes(form.blockMinutes);
    const perBlock = parsePeso(form.amountPerBlock);
    if (form.kind === 'FIXED_PER_BLOCK') {
      if (!block) next.blockMinutes = 'Enter whole minutes from 1 to 480';
      if (perBlock === null) next.amountPerBlockCentavos = 'Enter an amount such as 50';
    }
    const parsed = tiers.map((t) => ({
      upToMinutes: minutes(t.upTo),
      amountCentavos: parsePeso(t.amount),
    }));
    if (form.kind === 'TIERED')
      parsed.forEach((t, i) => {
        if (!t.upToMinutes) next[`tiers.${i}.upToMinutes`] = 'Whole minutes, 1–480';
        if (t.amountCentavos === null) next[`tiers.${i}.amountCentavos`] = 'Enter an amount';
      });
    setErrors(next);
    if (Object.keys(next).length) return;
    savePolicy.mutate(
      {
        id: policy?.id ?? null,
        body: {
          name: form.name.trim(),
          kind: form.kind,
          blockMinutes: form.kind === 'FIXED_PER_BLOCK' ? block : null,
          amountPerBlockCentavos: form.kind === 'FIXED_PER_BLOCK' ? perBlock : null,
          chargePartialBlock: form.chargePartialBlock,
          tiers:
            form.kind === 'TIERED'
              ? parsed.map((t) => ({
                  upToMinutes: t.upToMinutes!,
                  amountCentavos: t.amountCentavos!,
                }))
              : null,
          isActive: form.isActive,
        },
      },
      { onSuccess: onClose, onError: (err) => setErrors(serverErrors(err)) },
    );
  };

  return (
    <Dialog open onClose={onClose} title={policy ? 'Edit policy' : 'Add policy'}>
      <form
        noValidate
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Name"
          value={form.name}
          onChange={set('name')}
          error={errors.name}
          maxLength={100}
        />
        <SelectField
          label="Deduct by"
          value={form.kind}
          onChange={set('kind')}
          options={UNDERTIME_POLICY_KINDS.map((k) => ({ value: k, label: UNDERTIME_KIND[k] }))}
        />
        {form.kind === 'HOURLY_EQUIVALENT' && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Each late or undertime minute is deducted at the employee’s hourly rate.
          </p>
        )}
        {form.kind === 'FIXED_PER_BLOCK' && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Block (minutes)"
                type="number"
                inputMode="numeric"
                min={1}
                max={480}
                value={form.blockMinutes}
                onChange={set('blockMinutes')}
                error={errors.blockMinutes}
              />
              <TextField
                label="Amount per block (₱)"
                inputMode="decimal"
                value={form.amountPerBlock}
                onChange={set('amountPerBlock')}
                error={errors.amountPerBlockCentavos}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={form.chargePartialBlock}
                onChange={(e) => setForm((f) => ({ ...f, chargePartialBlock: e.target.checked }))}
              />
              Count a started block as a full block
            </label>
          </>
        )}
        {form.kind === 'TIERED' && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">
              Tiers (minutes late or under in a day)
            </legend>
            {tiers.map((t, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
                <TextField
                  label={`Up to (min) — tier ${i + 1}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={480}
                  value={t.upTo}
                  onChange={(e) =>
                    setTiers((ts) =>
                      ts.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)),
                    )
                  }
                  error={errors[`tiers.${i}.upToMinutes`]}
                />
                <TextField
                  label="Deduct (₱)"
                  inputMode="decimal"
                  value={t.amount}
                  onChange={(e) =>
                    setTiers((ts) =>
                      ts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                    )
                  }
                  error={errors[`tiers.${i}.amountCentavos`]}
                />
                <Button
                  variant="ghost"
                  className="mt-6"
                  aria-label={`Remove tier ${i + 1}`}
                  disabled={tiers.length === 1}
                  onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}
                >
                  ✕
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                disabled={tiers.length >= 10}
                onClick={() => setTiers((ts) => [...ts, { upTo: '', amount: '' }])}
              >
                Add tier
              </Button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Beyond the last tier, minutes are deducted at the hourly-rate equivalent.
            </p>
            <FormError message={errors.tiers} />
          </fieldset>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={form.isActive}
            disabled={policy?.isDefault}
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
          />
          Active (can be chosen for pay terms)
        </label>
        <FormError message={errors.form ?? errors.isActive} />
        <DialogActions onCancel={onClose} pending={savePolicy.isPending} label="Save" />
      </form>
    </Dialog>
  );
}

// ── Allowance and deduction types ────────────────────────────────────────────

function ItemTypesSection() {
  const types = usePayItemTypes();
  const [editing, setEditing] = useState<PayItemTypeView | 'new' | null>(null);
  return (
    <section className={sectionClass} aria-labelledby="item-types">
      <SectionHeader
        id="item-types"
        title="Allowance and deduction types"
        description="The kinds of recurring amounts HR can give employees, such as transport allowance, SSS or withholding tax."
        action={<Button onClick={() => setEditing('new')}>Add type</Button>}
      />
      {types.isError ? (
        <Alert tone="error">{errorMessage(types.error)}</Alert>
      ) : types.isPending ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {types.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {t.name}
                  <Badge tone={t.direction === 'ALLOWANCE' ? 'success' : 'neutral'}>
                    {ITEM_DIRECTION[t.direction]}
                  </Badge>
                  {!t.isActive && <Badge>Inactive</Badge>}
                </p>
                <p className="font-mono text-xs text-slate-500 dark:text-slate-400">{t.code}</p>
              </div>
              <Button variant="secondary" onClick={() => setEditing(t)}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ItemTypeDialog
          type={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function ItemTypeDialog({ type, onClose }: { type: PayItemTypeView | null; onClose: () => void }) {
  const { saveItemType } = usePayrollSetupMutations();
  const [form, setForm] = useState({
    code: type?.code ?? '',
    name: type?.name ?? '',
    direction: (type?.direction ?? 'ALLOWANCE') as PayItemDirection,
    isActive: type?.isActive ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (k: 'code' | 'name' | 'direction') => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog open onClose={onClose} title={type ? 'Edit type' : 'Add type'}>
      <form
        noValidate
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const next: Record<string, string> = {};
          const code = form.code.trim().toUpperCase();
          if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(code))
            next.code = 'Use 1–20 letters, digits or underscores, starting with a letter';
          if (form.name.trim().length < 2) next.name = 'Enter a name';
          setErrors(next);
          if (Object.keys(next).length) return;
          saveItemType.mutate(
            {
              id: type?.id ?? null,
              body: {
                code,
                name: form.name.trim(),
                direction: form.direction,
                isActive: form.isActive,
              },
            },
            { onSuccess: onClose, onError: (err) => setErrors(serverErrors(err)) },
          );
        }}
      >
        <TextField
          label="Name"
          value={form.name}
          onChange={set('name')}
          error={errors.name}
          maxLength={100}
        />
        <TextField
          label="Code"
          value={form.code}
          onChange={set('code')}
          error={errors.code}
          maxLength={20}
          hint="Short reference used on reports, such as TRANSPO."
          autoCapitalize="characters"
        />
        <SelectField
          label="Kind"
          value={form.direction}
          onChange={set('direction')}
          error={errors.direction}
          options={PAY_ITEM_DIRECTIONS.map((d) => ({ value: d, label: ITEM_DIRECTION[d] }))}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={form.isActive}
            onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
          />
          Active (can be given to employees and counted in pay)
        </label>
        <FormError message={errors.form} />
        <DialogActions onCancel={onClose} pending={saveItemType.isPending} label="Save" />
      </form>
    </Dialog>
  );
}
