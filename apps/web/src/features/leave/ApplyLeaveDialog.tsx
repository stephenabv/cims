import { applyLeaveSchema } from '@cims/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { useApplyLeave, useLeavePreview, useLeaveTypes } from './api';

/** File a leave request. The working-day count comes from the server (schedule and holidays). */
export function ApplyLeaveDialog({ onClose }: { onClose: () => void }) {
  const types = useLeaveTypes();
  const apply = useApplyLeave();
  const [form, setForm] = useState({ leaveTypeId: '', startDate: '', endDate: '', reason: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => {
      const next = { ...f, [k]: e.target.value };
      // Picking a start date after the end date moves the end date along.
      if (k === 'startDate' && (!f.endDate || f.endDate < next.startDate))
        next.endDate = next.startDate;
      return next;
    });

  const canPreview =
    !!form.leaveTypeId && !!form.startDate && !!form.endDate && form.startDate <= form.endDate;
  const preview = useLeavePreview(
    canPreview
      ? { leaveTypeId: form.leaveTypeId, startDate: form.startDate, endDate: form.endDate }
      : null,
  );

  return (
    <Dialog open onClose={onClose} title="Apply for leave">
      <form
        noValidate
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = applyLeaveSchema.safeParse(form);
          if (!parsed.success) {
            const fe: Record<string, string> = {};
            for (const i of parsed.error.issues) fe[String(i.path[0])] ??= i.message;
            if (!form.leaveTypeId) fe.leaveTypeId = 'Choose a leave type';
            return setErrors(fe);
          }
          setErrors({});
          setFormError(undefined);
          apply.mutate(parsed.data, {
            onSuccess: onClose,
            onError: (err) => {
              const fe = err instanceof ApiError ? err.fieldErrors() : {};
              if (Object.keys(fe).length) setErrors(fe);
              else setFormError(errorMessage(err));
            },
          });
        }}
      >
        <SelectField
          label="Leave type"
          value={form.leaveTypeId}
          onChange={set('leaveTypeId')}
          placeholder={types.isPending ? 'Loading…' : 'Choose…'}
          options={(types.data ?? []).map((t) => ({
            value: t.id,
            label: t.isPaid ? t.name : `${t.name} (unpaid)`,
          }))}
          error={errors.leaveTypeId}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="First day"
            type="date"
            value={form.startDate}
            onChange={set('startDate')}
            error={errors.startDate}
          />
          <TextField
            label="Last day"
            type="date"
            value={form.endDate}
            min={form.startDate || undefined}
            onChange={set('endDate')}
            error={errors.endDate}
          />
        </div>
        <p aria-live="polite" className="min-h-5 text-sm text-slate-600 dark:text-slate-400">
          {canPreview &&
            (preview.isError
              ? errorMessage(preview.error)
              : preview.data
                ? preview.data.days === 0
                  ? 'No working days in this range.'
                  : `${preview.data.days} working ${preview.data.days === 1 ? 'day' : 'days'} (rest days and holidays are not counted).`
                : 'Counting working days…')}
        </p>
        <TextField
          label="Reason"
          maxLength={1000}
          value={form.reason}
          onChange={set('reason')}
          error={errors.reason}
        />
        {formError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {formError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={apply.isPending}>
            Submit request
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
