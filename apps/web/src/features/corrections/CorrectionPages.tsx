import {
  CORRECTION_STATUSES,
  type CorrectionRequestView,
  type CorrectionStatus,
} from '@cims/shared';
import { clsx } from 'clsx';
import { type ReactNode, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListSkeleton } from '@/components/ui/Skeleton';
import { Pagination } from '@/components/ui/Pagination';
import { TextArea } from '@/components/ui/TextArea';
import { ApiError, errorMessage } from '@/lib/api-client';
import { formatTime, formatWorkDate } from '@/lib/datetime';
import { STEP_KIND, STEP_STATUS } from '../leave/labels';
import {
  useCancelCorrection,
  useCorrectionApprovals,
  useDecideCorrection,
  useMyCorrections,
} from './api';
import { CORRECTION_STATUS, CORRECTION_TYPE } from './labels';

const PAGE_SIZE = 20;

type Tab = 'mine' | 'review';

/**
 * Attendance corrections: the employee's own requests and, for approvers, the ones waiting for
 * them. One page with two tabs so supervisors (who may hold no special permission) find it.
 */
export function CorrectionsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'review' ? 'review' : 'mine';
  const review = useCorrectionApprovals(1);
  const waiting = review.data?.meta.total ?? 0;
  const setTab = (t: Tab) => setParams(t === 'review' ? { tab: 'review' } : {}, { replace: true });

  return (
    <>
      <PageHeader
        title="Attendance corrections"
        description="Ask for a wrong or missing punch to be fixed, and follow the decision. Official records change only after approval."
      />
      <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label="Correction requests">
        <TabButton active={tab === 'mine'} onClick={() => setTab('mine')}>
          My requests
        </TabButton>
        <TabButton active={tab === 'review'} onClick={() => setTab('review')}>
          To review
          {waiting > 0 && (
            <span className="ml-1.5 rounded-full bg-sun-400 px-1.5 text-xs font-bold text-brand-950">
              {waiting}
            </span>
          )}
        </TabButton>
      </div>
      {tab === 'mine' ? <MyRequests /> : <ReviewQueue />}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        'inline-flex min-h-10 items-center rounded-full px-4 text-sm font-semibold ring-1 ring-inset transition-colors',
        active
          ? 'bg-brand-700 text-white ring-brand-700'
          : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700',
      )}
    >
      {children}
    </button>
  );
}

function MyRequests() {
  const [status, setStatus] = useState<CorrectionStatus | undefined>();
  const [page, setPage] = useState(1);
  const list = useMyCorrections(status, page);
  const [cancelling, setCancelling] = useState<CorrectionRequestView | null>(null);

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2" aria-label="Filter by status">
        {[undefined, ...CORRECTION_STATUSES].map((s) => (
          <button
            key={s ?? 'all'}
            type="button"
            aria-pressed={status === s}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
            className={clsx(
              'min-h-9 rounded-full px-3 text-xs font-medium ring-1 ring-inset',
              status === s
                ? 'bg-brand-50 text-brand-800 ring-brand-200 dark:bg-brand-900/40 dark:text-brand-100 dark:ring-brand-700'
                : 'text-slate-600 ring-slate-200 hover:bg-slate-50 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800',
            )}
          >
            {s ? CORRECTION_STATUS[s].label : 'All'}
          </button>
        ))}
      </div>
      {list.isError ? (
        <Alert tone="error">{errorMessage(list.error)}</Alert>
      ) : list.isPending ? (
        <ListSkeleton rows={3} />
      ) : list.data.data.length === 0 ? (
        <EmptyState
          title="No correction requests"
          description="To request one, open My attendance and choose “Request correction” on the day that is wrong."
          action={
            <Link
              to="/app/attendance"
              className="text-sm font-semibold text-brand-700 hover:underline dark:text-brand-200"
            >
              Go to My attendance
            </Link>
          }
        />
      ) : (
        <>
          <ul className="grid gap-3">
            {list.data.data.map((r) => (
              <CorrectionCard
                key={r.id}
                request={r}
                actions={
                  r.can.cancel && (
                    <Button variant="secondary" size="sm" onClick={() => setCancelling(r)}>
                      Cancel request
                    </Button>
                  )
                }
              />
            ))}
          </ul>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={list.data.meta.total}
            onPage={setPage}
          />
        </>
      )}
      {cancelling && <CancelDialog request={cancelling} onClose={() => setCancelling(null)} />}
    </>
  );
}

function ReviewQueue() {
  const [page, setPage] = useState(1);
  const list = useCorrectionApprovals(page);
  const [deciding, setDeciding] = useState<{
    request: CorrectionRequestView;
    decision: 'APPROVE' | 'REJECT';
  } | null>(null);

  if (list.isError) return <Alert tone="error">{errorMessage(list.error)}</Alert>;
  if (list.isPending) return <ListSkeleton rows={3} />;
  if (list.data.data.length === 0)
    return (
      <EmptyState
        title="Nothing to review"
        description="Requests from people you approve for appear here when they need your decision."
      />
    );
  return (
    <>
      <ul className="grid gap-3">
        {list.data.data.map((r) => (
          <CorrectionCard
            key={r.id}
            request={r}
            showEmployee
            actions={
              r.can.decide && (
                <>
                  <Button
                    size="sm"
                    onClick={() => setDeciding({ request: r, decision: 'APPROVE' })}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setDeciding({ request: r, decision: 'REJECT' })}
                  >
                    Reject
                  </Button>
                </>
              )
            }
          />
        ))}
      </ul>
      <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.meta.total} onPage={setPage} />
      {deciding && (
        <DecisionDialog
          request={deciding.request}
          decision={deciding.decision}
          onClose={() => setDeciding(null)}
        />
      )}
    </>
  );
}

/** A request with the original and requested values side by side, the record now, and its approvals. */
export function CorrectionCard({
  request: r,
  showEmployee = false,
  actions,
}: {
  request: CorrectionRequestView;
  showEmployee?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const status = CORRECTION_STATUS[r.status];
  const tz = r.timezone;
  const punchLabel =
    r.punchType === 'TIME_OUT' ? 'Time out' : r.punchType === 'TIME_IN' ? 'Time in' : 'Punch';
  const stamp = (iso: string | null) =>
    iso ? `${formatTime(iso, tz)}${dayNote(iso, r.workDate, tz)}` : '—';
  return (
    <li className="rounded-[var(--radius-card)] bg-white p-5 shadow-[var(--shadow-card)] ring-1 ring-slate-200/70 dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {showEmployee && (
            <p className="font-semibold text-brand-950 dark:text-white">
              {r.employee.fullName}{' '}
              <span className="font-mono text-xs font-normal text-slate-500">
                {r.employee.accountNumber}
              </span>
            </p>
          )}
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{CORRECTION_TYPE[r.type].label}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
            Record of {formatWorkDate(r.workDate, { year: true })} · filed{' '}
            {new Date(r.submittedAt).toLocaleDateString()}
          </p>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>

      {r.type !== 'OTHER' && (
        <dl className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Compare label={`Original ${punchLabel.toLowerCase()}`} value={stamp(r.originalAt)} />
          <Compare label="Requested" value={stamp(r.requestedAt)} highlight />
          <Compare
            label="Applied"
            value={r.status === 'APPROVED' ? stamp(r.appliedAt) : 'Not yet'}
          />
        </dl>
      )}

      <p className="mt-3 text-sm break-words text-slate-700 dark:text-slate-300">
        <span className="font-medium">Reason:</span> “{r.reason}”
      </p>
      {r.decisionNote && (
        <p className="mt-1 text-sm break-words text-slate-700 dark:text-slate-300">
          <span className="font-medium">{r.status === 'REJECTED' ? 'Rejected' : 'Remarks'}:</span> “
          {r.decisionNote}”{r.decidedBy ? ` · ${r.decidedBy}` : ''}
        </p>
      )}

      <button
        type="button"
        aria-expanded={open}
        aria-controls={`correction-${r.id}`}
        onClick={() => setOpen((o) => !o)}
        className="mt-3 min-h-9 rounded-lg text-xs font-semibold text-brand-700 hover:underline dark:text-brand-200"
      >
        {open ? 'Hide details' : 'Record and approvals'}
      </button>
      {open && (
        <div id={`correction-${r.id}`} className="mt-2 grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Record now
            </p>
            {r.currentPunches.length === 0 ? (
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">No punches.</p>
            ) : (
              <ul className="mt-1 grid gap-1 text-sm">
                {r.currentPunches.map((p) => (
                  <li
                    key={p.id}
                    className={clsx(p.status === 'VOIDED' && 'text-slate-400 line-through')}
                  >
                    {p.type === 'TIME_IN' ? 'In' : 'Out'} {stamp(p.occurredAt)}
                    {p.status === 'VOIDED' && <span className="sr-only"> (voided)</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Approvals
            </p>
            <ol className="mt-1 grid gap-2 border-l-2 border-slate-200 pl-3 dark:border-slate-700">
              {r.steps.map((s) => (
                <li key={s.position} className="text-sm">
                  <span className="font-medium">
                    {s.approver ?? STEP_KIND[s.kind as keyof typeof STEP_KIND]}
                  </span>{' '}
                  <Badge tone={STEP_STATUS[s.status as keyof typeof STEP_STATUS].tone}>
                    {STEP_STATUS[s.status as keyof typeof STEP_STATUS].label}
                  </Badge>
                  {s.actedBy && <span className="text-xs text-slate-500"> by {s.actedBy}</span>}
                  {s.note && (
                    <p className="text-xs break-words text-slate-600 dark:text-slate-400">
                      “{s.note}”
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </li>
  );
}

function Compare({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={clsx(
        'rounded-xl px-3 py-2',
        highlight
          ? 'bg-sun-50 ring-1 ring-sun-200 dark:bg-sun-700/20 dark:ring-sun-700/40'
          : 'bg-slate-50 dark:bg-slate-800/60',
      )}
    >
      <dt className="text-xs text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** " (next day)" when an instant falls on a later calendar day than the record's date. */
function dayNote(iso: string, workDate: string, tz: string): string {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso));
  return d === workDate ? '' : ` (${formatWorkDate(d)})`;
}

function DecisionDialog({
  request,
  decision,
  onClose,
}: {
  request: CorrectionRequestView;
  decision: 'APPROVE' | 'REJECT';
  onClose: () => void;
}) {
  const decide = useDecideCorrection();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const approve = decision === 'APPROVE';
  const last = !request.steps.some((s) => s.status === 'WAITING');
  return (
    <Dialog
      open
      onClose={onClose}
      title={approve ? 'Approve this correction?' : 'Reject this correction?'}
    >
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {request.employee.fullName}: {CORRECTION_TYPE[request.type].label.toLowerCase()} for{' '}
        {formatWorkDate(request.workDate)}.{' '}
        {approve
          ? last
            ? request.type === 'OTHER'
              ? 'No punch changes automatically; update the record yourself if needed.'
              : 'The official record is updated now; the original punch is kept as voided.'
            : 'It then goes to the next approver.'
          : 'The employee sees your reason.'}
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
            {
              onSuccess: onClose,
              onError: (err) =>
                setError((err instanceof ApiError && err.fieldErrors().note) || errorMessage(err)),
            },
          );
        }}
      >
        <TextArea
          label={approve ? 'Remarks (optional)' : 'Reason for rejecting'}
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

function CancelDialog({
  request,
  onClose,
}: {
  request: CorrectionRequestView;
  onClose: () => void;
}) {
  const cancel = useCancelCorrection();
  const [error, setError] = useState<string>();
  return (
    <Dialog open onClose={onClose} title="Cancel this request?">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        {CORRECTION_TYPE[request.type].label} for {formatWorkDate(request.workDate)}. It stays in
        your history as cancelled.
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
          loading={cancel.isPending}
          onClick={() =>
            cancel.mutate(
              { id: request.id, version: request.version },
              { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
            )
          }
        >
          Cancel request
        </Button>
      </div>
    </Dialog>
  );
}
