import type { AttendanceConflictView } from '@cims/shared';
import { clsx } from 'clsx';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { ApiError, errorMessage } from '@/lib/api-client';
import { formatTime, formatWorkDate } from '@/lib/datetime';
import { useKioskStatus } from '../kiosk/api';
import { useAttendanceConflicts, useResolveConflict } from './api';
import { CONFLICT_REASON } from './labels';

const PAGE_SIZE = 20;
const TABS = [
  { value: 'OPEN', label: 'Needs review' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'REJECTED', label: 'Rejected' },
] as const;
type Tab = (typeof TABS)[number]['value'];

/** HR review of offline punches that did not fit existing records (spec §4). */
export function ConflictsPage() {
  const [params, setParams] = useSearchParams();
  const status = (TABS.find((t) => t.value === params.get('status'))?.value ?? 'OPEN') as Tab;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const conflicts = useAttendanceConflicts(status, page, PAGE_SIZE);
  const timezone = useKioskStatus(null).data?.timezone ?? 'Asia/Manila';
  const [reviewing, setReviewing] = useState<{
    conflict: AttendanceConflictView;
    decision: 'ACCEPT' | 'REJECT';
  } | null>(null);

  return (
    <>
      <PageHeader
        title="Offline sync conflicts"
        description="Punches recorded while a kiosk was offline that did not fit the employee's existing records. Nothing is applied until you decide."
      />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Conflict status">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={status === t.value}
            onClick={() => setParams({ status: t.value }, { replace: true })}
            className={clsx(
              'inline-flex min-h-9 items-center rounded-full px-3 text-sm font-medium ring-1 ring-inset',
              status === t.value
                ? 'bg-brand-700 text-white ring-brand-700'
                : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {conflicts.isError ? (
        <Alert tone="error">{errorMessage(conflicts.error)}</Alert>
      ) : conflicts.isPending ? (
        <div className="flex justify-center py-12 text-brand-700">
          <Spinner />
        </div>
      ) : conflicts.data.data.length === 0 ? (
        <EmptyState
          title={status === 'OPEN' ? 'Nothing to review' : 'No conflicts here'}
          description={
            status === 'OPEN' ? 'All offline punches fitted existing records.' : undefined
          }
        />
      ) : (
        <>
          <ul className="grid gap-3">
            {conflicts.data.data.map((c) => (
              <li
                key={c.id}
                className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      to={`/app/attendance/employees/${c.employee.id}?from=${c.punch.workDate}&to=${c.punch.workDate}`}
                      className="font-medium text-brand-700 hover:underline dark:text-brand-100"
                    >
                      {c.employee.fullName}
                    </Link>{' '}
                    <span className="font-mono text-xs text-slate-500">
                      {c.employee.accountNumber}
                    </span>
                    <p className="mt-1 text-sm">
                      <Badge tone={c.punch.type === 'TIME_IN' ? 'info' : 'neutral'}>
                        {c.punch.type === 'TIME_IN' ? 'Time in' : 'Time out'}
                      </Badge>{' '}
                      {formatWorkDate(c.punch.workDate, { year: true })} at{' '}
                      {formatTime(c.punch.occurredAt, timezone)}
                      {c.punch.device ? ` · ${c.punch.device}` : ''}
                    </p>
                    <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
                      {CONFLICT_REASON[c.reason] ?? c.reason}
                    </p>
                    {c.resolution && (
                      <p className="mt-1 text-xs text-slate-500">
                        {c.resolution.by ?? 'Someone'}: “{c.resolution.note}”
                      </p>
                    )}
                  </div>
                  {c.status === 'OPEN' && (
                    <div className="flex gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => setReviewing({ conflict: c, decision: 'REJECT' })}
                      >
                        Reject
                      </Button>
                      <Button onClick={() => setReviewing({ conflict: c, decision: 'ACCEPT' })}>
                        Accept
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={conflicts.data.meta.total}
            onPage={(p) => setParams({ status, page: String(p) }, { replace: true })}
          />
        </>
      )}

      {reviewing && (
        <ResolveDialog
          key={reviewing.conflict.id + reviewing.decision}
          {...reviewing}
          onClose={() => setReviewing(null)}
        />
      )}
    </>
  );
}

function ResolveDialog({
  conflict,
  decision,
  onClose,
}: {
  conflict: AttendanceConflictView;
  decision: 'ACCEPT' | 'REJECT';
  onClose: () => void;
}) {
  const resolve = useResolveConflict();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const accept = decision === 'ACCEPT';
  return (
    <Dialog open onClose={onClose} title={accept ? 'Accept this punch?' : 'Reject this punch?'}>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {accept
          ? `The punch is added to ${conflict.employee.fullName}'s attendance and the day is recalculated.`
          : `The punch is kept for the record but ignored in ${conflict.employee.fullName}'s attendance.`}{' '}
        This decision is final and recorded in the audit log.
      </p>
      <form
        noValidate
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim().length < 3) return setError('Explain the decision.');
          setError(undefined);
          resolve.mutate(
            { id: conflict.id, body: { decision, note: note.trim() } },
            {
              onSuccess: onClose,
              onError: (err) =>
                setError(
                  err instanceof ApiError && err.fieldErrors().note
                    ? err.fieldErrors().note
                    : errorMessage(err),
                ),
            },
          );
        }}
      >
        <TextField
          label="Reason"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={error}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={accept ? 'primary' : 'danger'} loading={resolve.isPending}>
            {accept ? 'Accept punch' : 'Reject punch'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
