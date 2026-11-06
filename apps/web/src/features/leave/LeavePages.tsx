import { LEAVE_STATUSES, type LeaveRequestView, type LeaveStatus } from '@cims/shared';
import { clsx } from 'clsx';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pagination } from '@/components/ui/Pagination';
import { Spinner } from '@/components/ui/Spinner';
import { errorMessage } from '@/lib/api-client';
import { ApplyLeaveDialog } from './ApplyLeaveDialog';
import { useLeaveApprovals, useLeaveRequests, useMyBalances, useMyLeave } from './api';
import { LEAVE_STATUS } from './labels';
import { CancelDialog, DecisionDialog, LeaveRequestCard, WithdrawDialog } from './LeaveRequestCard';

const PAGE_SIZE = 20;

function usePagedStatus() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('status');
  const status = LEAVE_STATUSES.find((s) => s === raw) as LeaveStatus | undefined;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const go = (next: { status?: LeaveStatus; page?: number }) => {
    const p = new URLSearchParams();
    if (next.status) p.set('status', next.status);
    if (next.page && next.page > 1) p.set('page', String(next.page));
    setParams(p, { replace: true });
  };
  return { status, page, go };
}

function StatusTabs({
  value,
  onChange,
}: {
  value: LeaveStatus | undefined;
  onChange: (s: LeaveStatus | undefined) => void;
}) {
  const tabs: { value: LeaveStatus | undefined; label: string }[] = [
    { value: undefined, label: 'All' },
    ...LEAVE_STATUSES.map((s) => ({ value: s, label: LEAVE_STATUS[s].label })),
  ];
  return (
    <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Request status">
      {tabs.map((t) => (
        <button
          key={t.label}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={clsx(
            'inline-flex min-h-9 items-center rounded-full px-3 text-sm font-medium ring-1 ring-inset',
            value === t.value
              ? 'bg-brand-700 text-white ring-brand-700'
              : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-700',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function RequestList({
  query,
  empty,
  showEmployee,
  renderActions,
  onPage,
  page,
}: {
  query: ReturnType<typeof useMyLeave>;
  empty: { title: string; description?: string };
  showEmployee?: boolean;
  renderActions?: (r: LeaveRequestView) => React.ReactNode;
  onPage: (p: number) => void;
  page: number;
}) {
  if (query.isError) return <Alert tone="error">{errorMessage(query.error)}</Alert>;
  if (query.isPending)
    return (
      <div className="flex justify-center py-12 text-brand-700">
        <Spinner />
      </div>
    );
  if (query.data.data.length === 0) return <EmptyState {...empty} />;
  return (
    <>
      <ul className="grid gap-3">
        {query.data.data.map((r) => (
          <LeaveRequestCard
            key={r.id}
            request={r}
            showEmployee={showEmployee}
            actions={renderActions?.(r)}
          />
        ))}
      </ul>
      <Pagination page={page} pageSize={PAGE_SIZE} total={query.data.meta.total} onPage={onPage} />
    </>
  );
}

/** Employee self-service: balances, apply, history, withdraw (spec §3.3). */
export function MyLeavePage() {
  const year = new Date().getFullYear();
  const { status, page, go } = usePagedStatus();
  const mine = useMyLeave(status, page, PAGE_SIZE);
  const balances = useMyBalances(year);
  const waiting = useLeaveApprovals(1, 1);
  const [applying, setApplying] = useState(false);
  const [withdrawing, setWithdrawing] = useState<LeaveRequestView | null>(null);

  const shown = (balances.data ?? []).filter(
    (b) => b.allottedDays !== null || b.approvedDays > 0 || b.pendingDays > 0,
  );

  return (
    <>
      <PageHeader
        title="My leave"
        description="Apply for leave and follow each request through its approvals."
      />
      {(waiting.data?.meta.total ?? 0) > 0 && (
        <Alert tone="info">
          {waiting.data!.meta.total} leave{' '}
          {waiting.data!.meta.total === 1 ? 'request is' : 'requests are'} waiting for your
          approval.{' '}
          <Link to="/app/leave/approvals" className="font-medium underline">
            Review now
          </Link>
        </Alert>
      )}
      <div className="my-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{year} at a glance</h2>
        <Button onClick={() => setApplying(true)}>Apply for leave</Button>
      </div>
      {balances.isError ? (
        <Alert tone="error">{errorMessage(balances.error)}</Alert>
      ) : shown.length === 0 ? (
        <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
          No leave taken or pending this year.
        </p>
      ) : (
        <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {shown.map((b) => (
            <div
              key={b.leaveType.id}
              className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
            >
              <dt className="text-xs text-slate-500 dark:text-slate-400">{b.leaveType.name}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {b.remainingDays !== null ? `${b.remainingDays} left` : `${b.approvedDays} used`}
              </dd>
              <dd className="text-xs text-slate-500 dark:text-slate-400">
                {b.allottedDays !== null && `${b.approvedDays} of ${b.allottedDays} used`}
                {b.pendingDays > 0 &&
                  `${b.allottedDays !== null ? ' · ' : ''}${b.pendingDays} pending`}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <h2 className="mb-3 text-lg font-semibold">My requests</h2>
      <StatusTabs value={status} onChange={(s) => go({ status: s })} />
      <RequestList
        query={mine}
        page={page}
        onPage={(p) => go({ status, page: p })}
        empty={{ title: 'No leave requests', description: 'Requests you file appear here.' }}
        renderActions={(r) =>
          r.can.withdraw && (
            <Button variant="secondary" onClick={() => setWithdrawing(r)}>
              Withdraw
            </Button>
          )
        }
      />
      {applying && <ApplyLeaveDialog onClose={() => setApplying(false)} />}
      {withdrawing && (
        <WithdrawDialog
          key={withdrawing.id}
          request={withdrawing}
          onClose={() => setWithdrawing(null)}
        />
      )}
    </>
  );
}

/** Requests whose current step the viewer decides (supervisors, heads, HR). */
export function LeaveApprovalsPage() {
  const [page, setPage] = useState(1);
  const approvals = useLeaveApprovals(page, PAGE_SIZE);
  const [deciding, setDeciding] = useState<{
    request: LeaveRequestView;
    decision: 'APPROVE' | 'REJECT';
  } | null>(null);
  return (
    <>
      <PageHeader
        title="Leave approvals"
        description="Requests waiting for your decision, oldest first. Approved requests move on to the next approver, if any."
      />
      <RequestList
        query={approvals}
        page={page}
        onPage={setPage}
        showEmployee
        empty={{ title: 'Nothing to approve', description: 'You are all caught up.' }}
        renderActions={(r) =>
          r.can.decide && (
            <>
              <Button
                variant="secondary"
                onClick={() => setDeciding({ request: r, decision: 'REJECT' })}
              >
                Reject
              </Button>
              <Button onClick={() => setDeciding({ request: r, decision: 'APPROVE' })}>
                Approve
              </Button>
            </>
          )
        }
      />
      {deciding && (
        <DecisionDialog
          key={deciding.request.id + deciding.decision}
          {...deciding}
          onClose={() => setDeciding(null)}
        />
      )}
    </>
  );
}

/** HR and department heads: everyone's leave within their scope; HR can cancel. */
export function LeaveRequestsPage() {
  const { status, page, go } = usePagedStatus();
  const requests = useLeaveRequests({ status, page, pageSize: PAGE_SIZE });
  const [cancelling, setCancelling] = useState<LeaveRequestView | null>(null);
  return (
    <>
      <PageHeader
        title="Leave records"
        description="All leave requests you can see. Approved leave that has not started can be cancelled."
      />
      <StatusTabs value={status} onChange={(s) => go({ status: s })} />
      <RequestList
        query={requests}
        page={page}
        onPage={(p) => go({ status, page: p })}
        showEmployee
        empty={{ title: 'No leave requests' }}
        renderActions={(r) =>
          r.can.cancel && (
            <Button variant="secondary" onClick={() => setCancelling(r)}>
              Cancel
            </Button>
          )
        }
      />
      {cancelling && (
        <CancelDialog
          key={cancelling.id}
          request={cancelling}
          onClose={() => setCancelling(null)}
        />
      )}
    </>
  );
}
