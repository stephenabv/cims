import type { LeaveRequestView } from '@cims/shared';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { formatWorkDate } from '@/lib/datetime';
import { useCancelLeave, useDecideLeave, useWithdrawLeave } from './api';
import { LEAVE_STATUS, STEP_KIND, STEP_STATUS } from './labels';

export function dateRange(r: Pick<LeaveRequestView, 'startDate' | 'endDate'>): string {
  return r.startDate === r.endDate
    ? formatWorkDate(r.startDate, { year: true })
    : `${formatWorkDate(r.startDate)} – ${formatWorkDate(r.endDate, { year: true })}`;
}

/** One leave request with its approval trail. `showEmployee` for lists of other people's leave. */
export function LeaveRequestCard({
  request: r,
  showEmployee = false,
  actions,
}: {
  request: LeaveRequestView;
  showEmployee?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const status = LEAVE_STATUS[r.status];
  const detailsId = `leave-steps-${r.id}`;
  return (
    <li className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {showEmployee && (
            <p className="font-medium">
              {r.employee.fullName}{' '}
              <span className="font-mono text-xs text-slate-500">{r.employee.accountNumber}</span>
            </p>
          )}
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{r.leaveType.name}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
            {!r.leaveType.isPaid && <Badge tone="neutral">Unpaid</Badge>}
          </p>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
            {dateRange(r)} · {r.days} working {r.days === 1 ? 'day' : 'days'}
          </p>
          <p className="mt-1 text-sm break-words text-slate-600 dark:text-slate-400">
            “{r.reason}”
          </p>
          {r.endReason && (
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              Cancelled: “{r.endReason}”
            </p>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((o) => !o)}
        className="mt-2 min-h-9 rounded-lg text-xs font-medium text-brand-700 hover:underline dark:text-brand-100"
      >
        {open ? 'Hide approvals' : 'Show approvals'}
      </button>
      {open && (
        <ol
          id={detailsId}
          className="mt-1 grid gap-2 border-l-2 border-slate-200 pl-3 dark:border-slate-700"
        >
          {r.steps.map((s) => (
            <li key={s.position} className="text-sm">
              <span className="font-medium">{s.approver ?? STEP_KIND[s.kind]}</span>{' '}
              <Badge tone={STEP_STATUS[s.status].tone}>{STEP_STATUS[s.status].label}</Badge>
              {s.actedBy && (
                <span className="text-xs text-slate-500">
                  {' '}
                  by {s.actedBy}
                  {s.actedAt ? ` on ${new Date(s.actedAt).toLocaleDateString()}` : ''}
                </span>
              )}
              {s.note && (
                <p className="text-xs break-words text-slate-600 dark:text-slate-400">“{s.note}”</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function fieldOr(err: unknown, field: string): string {
  return (err instanceof ApiError && err.fieldErrors()[field]) || errorMessage(err);
}

export function DecisionDialog({
  request,
  decision,
  onClose,
}: {
  request: LeaveRequestView;
  decision: 'APPROVE' | 'REJECT';
  onClose: () => void;
}) {
  const decide = useDecideLeave();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const approve = decision === 'APPROVE';
  return (
    <Dialog open onClose={onClose} title={approve ? 'Approve this leave?' : 'Reject this leave?'}>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {request.employee.fullName}: {request.leaveType.name}, {dateRange(request)} ({request.days}{' '}
        {request.days === 1 ? 'day' : 'days'}).
        {approve && request.steps.some((s) => s.status === 'WAITING')
          ? ' It then goes to the next approver.'
          : ''}
      </p>
      <form
        noValidate
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!approve && note.trim().length < 3)
            return setError('Explain why the request is rejected');
          setError(undefined);
          decide.mutate(
            {
              id: request.id,
              body: { decision, note: note.trim() || undefined, version: request.version },
            },
            { onSuccess: onClose, onError: (err) => setError(fieldOr(err, 'note')) },
          );
        }}
      >
        <TextField
          label={approve ? 'Note (optional)' : 'Reason'}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={error}
          autoFocus
        />
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

export function WithdrawDialog({
  request,
  onClose,
}: {
  request: LeaveRequestView;
  onClose: () => void;
}) {
  const withdraw = useWithdrawLeave();
  const [error, setError] = useState<string>();
  return (
    <Dialog open onClose={onClose} title="Withdraw this request?">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {request.leaveType.name}, {dateRange(request)}. Approvers will no longer see it. You can
        file a new request afterwards.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Keep it
        </Button>
        <Button
          variant="danger"
          loading={withdraw.isPending}
          onClick={() =>
            withdraw.mutate(
              { id: request.id, version: request.version },
              { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
            )
          }
        >
          Withdraw
        </Button>
      </div>
    </Dialog>
  );
}

export function CancelDialog({
  request,
  onClose,
}: {
  request: LeaveRequestView;
  onClose: () => void;
}) {
  const cancel = useCancelLeave();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  return (
    <Dialog open onClose={onClose} title="Cancel this leave?">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {request.employee.fullName}: {request.leaveType.name}, {dateRange(request)}. The employee
        sees your reason. This cannot be undone.
      </p>
      <form
        noValidate
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim().length < 3) return setError('Give a reason');
          setError(undefined);
          cancel.mutate(
            { id: request.id, body: { reason: reason.trim(), version: request.version } },
            { onSuccess: onClose, onError: (err) => setError(fieldOr(err, 'reason')) },
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
            Back
          </Button>
          <Button type="submit" variant="danger" loading={cancel.isPending}>
            Cancel leave
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
