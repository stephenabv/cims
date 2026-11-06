import { type AttendanceDayView, PUNCH_TYPES, type PunchType, addPunchSchema } from '@cims/shared';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SelectField } from '@/components/ui/SelectField';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { formatTime, formatWorkDate } from '@/lib/datetime';
import { useAttendanceAdjustments } from './api';
import { PUNCH_SOURCE } from './labels';

type Punch = AttendanceDayView['punches'][number];

const TYPE_LABEL: Record<PunchType, string> = { TIME_IN: 'Time in', TIME_OUT: 'Time out' };

/**
 * The raw punches behind one day, including voided ones and HR notes. When `employeeId` is set
 * the viewer may correct them; the API enforces the same rule.
 */
export function DayPunches({
  day,
  timezone,
  employeeId,
}: {
  day: AttendanceDayView;
  timezone: string;
  employeeId?: string;
}) {
  const [voiding, setVoiding] = useState<Punch | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div className="grid gap-3">
      {day.punches.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">No punches on this day.</p>
      ) : (
        <ul className="grid gap-2">
          {day.punches.map((p) => {
            const voided = p.status === 'VOIDED';
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span
                  className={voided ? 'text-slate-400 line-through' : 'tabular-nums font-medium'}
                >
                  {TYPE_LABEL[p.type]} {formatTime(p.occurredAt, timezone)}
                </span>
                <Badge tone={p.source === 'ADJUSTMENT' ? 'info' : 'neutral'}>
                  {PUNCH_SOURCE[p.source] ?? p.source}
                </Badge>
                {voided && <Badge tone="danger">Voided</Badge>}
                {p.status === 'CONFLICT' && <Badge tone="warning">Awaiting review</Badge>}
                {p.note && (
                  <span className="min-w-0 text-xs break-words text-slate-500 dark:text-slate-400">
                    “{p.note}”
                  </span>
                )}
                {employeeId && p.status === 'ACCEPTED' && (
                  <Button
                    variant="ghost"
                    className="ml-auto min-h-8 px-2 py-1 text-xs"
                    onClick={() => setVoiding(p)}
                    aria-label={`Void ${TYPE_LABEL[p.type].toLowerCase()} at ${formatTime(p.occurredAt, timezone)}`}
                  >
                    Void
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {employeeId && (
        <div>
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add punch
          </Button>
        </div>
      )}
      {employeeId && adding && (
        <AddPunchDialog
          employeeId={employeeId}
          workDate={day.workDate}
          onClose={() => setAdding(false)}
        />
      )}
      {voiding && (
        <VoidPunchDialog punch={voiding} timezone={timezone} onClose={() => setVoiding(null)} />
      )}
    </div>
  );
}

function AddPunchDialog({
  employeeId,
  workDate,
  onClose,
}: {
  employeeId: string;
  workDate: string;
  onClose: () => void;
}) {
  const { addPunch } = useAttendanceAdjustments();
  const [form, setForm] = useState({
    type: 'TIME_IN' as PunchType,
    date: workDate,
    time: '',
    reason: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog open onClose={onClose} title={`Add a punch for ${formatWorkDate(workDate)}`}>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Use the company&apos;s local time. For a time-out after midnight, pick the next calendar
        day; it still counts toward the shift it closes. The change is audit-logged.
      </p>
      <form
        noValidate
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = addPunchSchema.safeParse(form);
          if (!parsed.success) {
            const fe: Record<string, string> = {};
            for (const i of parsed.error.issues) fe[String(i.path[0])] ??= i.message;
            return setErrors(fe);
          }
          setErrors({});
          setFormError(undefined);
          addPunch.mutate(
            { employeeId, body: parsed.data },
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
        <SelectField
          label="Type"
          value={form.type}
          onChange={set('type')}
          options={PUNCH_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Date"
            type="date"
            value={form.date}
            onChange={set('date')}
            error={errors.date}
          />
          <TextField
            label="Time"
            type="time"
            value={form.time}
            onChange={set('time')}
            error={errors.time}
          />
        </div>
        <TextField
          label="Reason"
          maxLength={500}
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
          <Button type="submit" loading={addPunch.isPending}>
            Add punch
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function VoidPunchDialog({
  punch,
  timezone,
  onClose,
}: {
  punch: Punch;
  timezone: string;
  onClose: () => void;
}) {
  const { voidPunch } = useAttendanceAdjustments();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  return (
    <Dialog open onClose={onClose} title="Void this punch?">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {TYPE_LABEL[punch.type]} at {formatTime(punch.occurredAt, timezone)} will be ignored when
        the day is calculated. It stays on record as voided, and the change is audit-logged.
      </p>
      <form
        noValidate
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length < 3) return setError('Give a reason');
          setError(undefined);
          voidPunch.mutate(
            { id: punch.id, body: { reason: reason.trim() } },
            {
              onSuccess: onClose,
              onError: (err) =>
                setError(
                  (err instanceof ApiError && err.fieldErrors().reason) || errorMessage(err),
                ),
            },
          );
        }}
      >
        <TextField
          label="Reason"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={error}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={voidPunch.isPending}>
            Void punch
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
