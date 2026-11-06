import {
  type AttendanceDayView,
  CORRECTION_NEEDS_TARGET,
  CORRECTION_NEEDS_TIME,
  CORRECTION_TYPES,
  type CorrectionType,
  submitCorrectionSchema,
} from '@cims/shared';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/SelectField';
import { TextArea } from '@/components/ui/TextArea';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { formatTime, formatWorkDate, wallClock } from '@/lib/datetime';
import { useSubmitCorrection } from './api';
import { CORRECTION_TYPE } from './labels';

type Errors = Partial<
  Record<'type' | 'targetEventId' | 'requestedDate' | 'requestedTime' | 'reason', string>
>;

/** Punch types a request type may target (INCORRECT_TIMESTAMP and OTHER: either). */
const TARGET_TYPE: Partial<Record<CorrectionType, 'TIME_IN' | 'TIME_OUT'>> = {
  CHANGE_TIME_IN: 'TIME_IN',
  CHANGE_TIME_OUT: 'TIME_OUT',
};

/**
 * Employee files a correction for one of their attendance records. The official record is not
 * touched here; the request goes to the approvers configured by HR.
 */
export function RequestCorrectionDialog({
  day,
  timezone,
  onClose,
}: {
  day: AttendanceDayView;
  timezone: string;
  onClose: () => void;
}) {
  const accepted = day.punches.filter((p) => p.status === 'ACCEPTED');
  const hasIn = accepted.some((p) => p.type === 'TIME_IN');
  const hasOut = accepted.some((p) => p.type === 'TIME_OUT');
  const suggested: CorrectionType = !hasIn
    ? 'MISSING_TIME_IN'
    : !hasOut
      ? 'MISSING_TIME_OUT'
      : 'CHANGE_TIME_IN';

  const [type, setType] = useState<CorrectionType>(suggested);
  const [targetEventId, setTarget] = useState('');
  const [requestedDate, setDate] = useState(day.workDate);
  const [requestedTime, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const submit = useSubmitCorrection();

  const needsTarget = CORRECTION_NEEDS_TARGET.includes(type);
  const needsTime = CORRECTION_NEEDS_TIME.includes(type);
  const targets = accepted.filter((p) => !TARGET_TYPE[type] || p.type === TARGET_TYPE[type]);
  const available = CORRECTION_TYPES.filter(
    (t) =>
      (t !== 'MISSING_TIME_IN' || !hasIn) &&
      (t !== 'MISSING_TIME_OUT' || !hasOut) &&
      (t !== 'CHANGE_TIME_IN' || hasIn) &&
      (t !== 'CHANGE_TIME_OUT' || hasOut) &&
      (t !== 'INCORRECT_TIMESTAMP' || accepted.length > 0),
  );

  function pickTarget(id: string) {
    setTarget(id);
    const p = accepted.find((x) => x.id === id);
    if (p) {
      const wc = wallClock(p.occurredAt, timezone);
      setDate(wc.date);
      setTime(wc.time);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      workDate: day.workDate,
      type,
      targetEventId:
        needsTarget || (type === 'OTHER' && targetEventId) ? targetEventId || undefined : undefined,
      requestedDate: needsTime ? requestedDate : undefined,
      requestedTime: needsTime ? requestedTime || undefined : undefined,
      reason,
    };
    const parsed = submitCorrectionSchema.safeParse(body);
    if (!parsed.success) {
      const fe: Errors = {};
      for (const i of parsed.error.issues) fe[i.path[0] as keyof Errors] ??= i.message;
      return setErrors(fe);
    }
    setErrors({});
    submit.mutate(parsed.data, {
      onSuccess: onClose,
      onError: (err) => {
        if (err instanceof ApiError) setErrors(err.fieldErrors() as Errors);
      },
    });
  }

  return (
    <Dialog open onClose={onClose} title={`Request a correction · ${formatWorkDate(day.workDate)}`}>
      <div className="mb-4 rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
        <p className="font-medium">On record now</p>
        {accepted.length === 0 ? (
          <p className="text-slate-600 dark:text-slate-400">No punches.</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-slate-700 dark:text-slate-300">
            {accepted.map((p) => (
              <li key={p.id}>
                {p.type === 'TIME_IN' ? 'In' : 'Out'} {formatTime(p.occurredAt, timezone)}
              </li>
            ))}
          </ul>
        )}
      </div>
      <form noValidate className="grid gap-4" onSubmit={onSubmit}>
        <SelectField
          label="What needs correcting?"
          value={type}
          onChange={(e) => {
            setType(e.target.value as CorrectionType);
            setTarget('');
          }}
          options={available.map((t) => ({ value: t, label: CORRECTION_TYPE[t].label }))}
          error={errors.type}
        />
        <p className="-mt-2 text-xs text-slate-500 dark:text-slate-400">
          {CORRECTION_TYPE[type].help}
        </p>

        {(needsTarget || (type === 'OTHER' && accepted.length > 0)) && (
          <SelectField
            label={needsTarget ? 'Punch to correct' : 'Related punch (optional)'}
            value={targetEventId}
            onChange={(e) => pickTarget(e.target.value)}
            placeholder="Choose a punch"
            options={targets.map((p) => ({
              value: p.id,
              label: `${p.type === 'TIME_IN' ? 'Time in' : 'Time out'} · ${formatTime(p.occurredAt, timezone)}`,
            }))}
            error={errors.targetEventId}
          />
        )}

        {needsTime && (
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="Correct date"
              type="date"
              value={requestedDate}
              onChange={(e) => setDate(e.target.value)}
              error={errors.requestedDate}
              hint="For a time out after midnight, use the next day."
            />
            <TextField
              label="Correct time"
              type="time"
              value={requestedTime}
              onChange={(e) => setTime(e.target.value)}
              error={errors.requestedTime}
            />
          </div>
        )}

        <TextArea
          label="Reason"
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
          hint="Required. Say what happened, e.g. the kiosk was offline when you arrived."
        />

        {submit.isError &&
          !(submit.error instanceof ApiError && Object.keys(submit.error.fieldErrors()).length) && (
            <Alert tone="error">{errorMessage(submit.error)}</Alert>
          )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submit.isPending}>
            Submit request
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
