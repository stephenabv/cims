import type { OvertimeRecordView } from '@cims/shared';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { formatMinutes, formatTime, formatWorkDate } from '@/lib/datetime';
import { useDecideOvertime } from './api';
import { OVERTIME_ACTION, OVERTIME_STATUS } from './labels';

/** One day's overtime with its decision history. */
export function OvertimeRecordCard({
  record: r,
  timezone,
  actions,
}: {
  record: OvertimeRecordView;
  timezone: string;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const status = OVERTIME_STATUS[r.status];
  const historyId = `overtime-history-${r.id}`;
  return (
    <li className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {r.employee.fullName}{' '}
            <span className="font-mono text-xs text-slate-500">{r.employee.accountNumber}</span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <span>{formatWorkDate(r.workDate, { year: true })}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
            {r.employee.department && (
              <span className="text-slate-500 dark:text-slate-400">{r.employee.department}</span>
            )}
          </p>
          <p className="mt-1 text-sm text-slate-700 tabular-nums dark:text-slate-300">
            {formatTime(r.firstIn, timezone)} – {formatTime(r.lastOut, timezone)} ·{' '}
            {formatMinutes(r.actualMinutes)} overtime
            {r.approvedMinutes !== null && r.approvedMinutes < r.actualMinutes && (
              <> · {formatMinutes(r.approvedMinutes)} approved</>
            )}
          </p>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {r.history.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={historyId}
            onClick={() => setOpen((o) => !o)}
            className="mt-2 min-h-9 rounded-lg text-xs font-medium text-brand-700 hover:underline dark:text-brand-100"
          >
            {open ? 'Hide history' : 'Show history'}
          </button>
          {open && (
            <ol
              id={historyId}
              className="mt-1 grid gap-2 border-l-2 border-slate-200 pl-3 dark:border-slate-700"
            >
              {r.history.map((h) => (
                <li key={h.actedAt + h.action} className="text-sm">
                  <span className="font-medium">{OVERTIME_ACTION[h.action]}</span>
                  {h.minutes !== null && h.action === 'APPROVE' && <> {formatMinutes(h.minutes)}</>}
                  <span className="text-xs text-slate-500">
                    {' '}
                    {h.actedBy ? `by ${h.actedBy}` : 'automatically'} on{' '}
                    {new Date(h.actedAt).toLocaleDateString()}
                  </span>
                  {h.note && (
                    <p className="text-xs break-words text-slate-600 dark:text-slate-400">
                      “{h.note}”
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </li>
  );
}

/** Parses "1:30", "90" or "1h 30m" into minutes; null when unreadable. */
export function parseMinutes(text: string): number | null {
  const t = text.trim().toLowerCase();
  let m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(?:(\d{1,2})\s*h)?\s*(?:(\d{1,3})\s*m?)?$/.exec(t);
  if (m && (m[1] || m[2])) return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return null;
}

const toHm = (minutes: number) =>
  `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

export function OvertimeDecisionDialog({
  record,
  decision,
  onClose,
}: {
  record: OvertimeRecordView;
  decision: 'APPROVE' | 'REJECT';
  onClose: () => void;
}) {
  const decide = useDecideOvertime();
  const approve = decision === 'APPROVE';
  const [amount, setAmount] = useState(toHm(record.actualMinutes));
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; note?: string; form?: string }>({});
  const minutes = parseMinutes(amount);
  const partial = approve && minutes !== null && minutes < record.actualMinutes;

  return (
    <Dialog open onClose={onClose} title={approve ? 'Approve overtime?' : 'Reject overtime?'}>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {record.employee.fullName}, {formatWorkDate(record.workDate, { year: true })}:{' '}
        {formatMinutes(record.actualMinutes)} beyond schedule.
        {approve ? ' Only approved time is paid.' : ' None of it will be paid.'}
      </p>
      <form
        noValidate
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const next: typeof errors = {};
          if (approve && (minutes === null || minutes < 1))
            next.amount = 'Enter hours and minutes, for example 1:30';
          else if (approve && minutes! > record.actualMinutes)
            next.amount = `At most ${toHm(record.actualMinutes)} was worked`;
          if ((!approve || partial) && note.trim().length < 3)
            next.note = approve
              ? 'Explain why only part is approved'
              : 'Explain why the overtime is rejected';
          setErrors(next);
          if (Object.keys(next).length) return;
          decide.mutate(
            {
              id: record.id,
              body: {
                decision,
                approvedMinutes: approve ? minutes! : undefined,
                note: note.trim() || undefined,
                version: record.version,
              },
            },
            {
              onSuccess: onClose,
              onError: (err) => {
                const fe = err instanceof ApiError ? err.fieldErrors() : {};
                setErrors({
                  amount: fe.approvedMinutes,
                  note: fe.note,
                  form: fe.approvedMinutes || fe.note ? undefined : errorMessage(err),
                });
              },
            },
          );
        }}
      >
        {approve && (
          <TextField
            label="Approved time (h:mm)"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint={`Worked ${toHm(record.actualMinutes)}. Lower it to approve part of the time.`}
            error={errors.amount}
            autoFocus
          />
        )}
        <TextField
          label={approve ? (partial ? 'Reason for approving part' : 'Note (optional)') : 'Reason'}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={errors.note}
          autoFocus={!approve}
        />
        {errors.form && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {errors.form}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button type="submit" variant={approve ? 'primary' : 'danger'} loading={decide.isPending}>
            {approve ? 'Approve' : 'Reject'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
