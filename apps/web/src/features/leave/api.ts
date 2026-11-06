import type {
  ApplyLeaveInput,
  ApprovalChainInput,
  ApprovalChainView,
  CancelLeaveInput,
  LeaveBalanceInput,
  LeaveBalanceView,
  LeaveDecisionInput,
  LeavePreview,
  LeaveRequestQuery,
  LeaveRequestView,
  LeaveStatus,
  LeaveTypeInput,
  LeaveTypeView,
  PaginatedResult,
} from '@cims/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

export const useLeaveTypes = () =>
  useQuery({ queryKey: ['leave', 'types'], queryFn: () => api<LeaveTypeView[]>('/leave/types') });

export const useMyBalances = (year: number) =>
  useQuery({
    queryKey: ['leave', 'balances', 'me', year],
    queryFn: () => api<LeaveBalanceView[]>(`/leave/balances/me/${year}`),
  });

export const useEmployeeBalances = (employeeId: string | undefined, year: number) =>
  useQuery({
    queryKey: ['leave', 'balances', employeeId, year],
    queryFn: () => api<LeaveBalanceView[]>(`/leave/balances/employees/${employeeId}/${year}`),
    enabled: !!employeeId,
  });

export const useLeavePreview = (
  input: {
    leaveTypeId: string;
    startDate: string;
    endDate: string;
  } | null,
) =>
  useQuery({
    queryKey: ['leave', 'preview', input],
    queryFn: () => api<LeavePreview>('/leave/preview', { method: 'POST', body: input }),
    enabled: !!input,
    retry: false,
  });

export const useMyLeave = (status: LeaveStatus | undefined, page: number, pageSize: number) =>
  useQuery({
    queryKey: ['leave', 'mine', status, page, pageSize],
    queryFn: () =>
      api<PaginatedResult<LeaveRequestView>>(
        `/leave/requests/mine?${qs({ status, page, pageSize })}`,
      ),
    placeholderData: keepPreviousData,
  });

export const useLeaveApprovals = (page: number, pageSize: number) =>
  useQuery({
    queryKey: ['leave', 'approvals', page, pageSize],
    queryFn: () =>
      api<PaginatedResult<LeaveRequestView>>(`/leave/requests/approvals?${qs({ page, pageSize })}`),
    placeholderData: keepPreviousData,
  });

export const useLeaveRequests = (q: Partial<LeaveRequestQuery>) =>
  useQuery({
    queryKey: ['leave', 'all', q],
    queryFn: () =>
      api<PaginatedResult<LeaveRequestView>>(
        `/leave/requests?${qs(q as Record<string, string | number | undefined>)}`,
      ),
    placeholderData: keepPreviousData,
  });

/** Every change refreshes all leave views (lists, balances) and attendance (leave days). */
function useLeaveMutation<TVars, TResult>(fn: (v: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['leave'] });
      void qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}

export const useApplyLeave = () =>
  useLeaveMutation((body: ApplyLeaveInput) =>
    api<LeaveRequestView>('/leave/requests', { method: 'POST', body }),
  );

export const useDecideLeave = () =>
  useLeaveMutation(({ id, body }: { id: string; body: LeaveDecisionInput }) =>
    api<LeaveRequestView>(`/leave/requests/${id}/decide`, { method: 'POST', body }),
  );

export const useWithdrawLeave = () =>
  useLeaveMutation(({ id, version }: { id: string; version: number }) =>
    api<LeaveRequestView>(`/leave/requests/${id}/withdraw`, { method: 'POST', body: { version } }),
  );

export const useCancelLeave = () =>
  useLeaveMutation(({ id, body }: { id: string; body: CancelLeaveInput }) =>
    api<LeaveRequestView>(`/leave/requests/${id}/cancel`, { method: 'POST', body }),
  );

// ── Configuration ─────────────────────────────────────────────────────────────

export const useAllLeaveTypes = () =>
  useQuery({
    queryKey: ['leave', 'config', 'types'],
    queryFn: () => api<LeaveTypeView[]>('/leave/config/types'),
  });

export const useApprovalChains = () =>
  useQuery({
    queryKey: ['leave', 'config', 'chains'],
    queryFn: () => api<ApprovalChainView[]>('/leave/config/chains'),
  });

export const useApproverRoles = () =>
  useQuery({
    queryKey: ['leave', 'config', 'roles'],
    queryFn: () => api<{ id: string; name: string }[]>('/leave/config/roles'),
    staleTime: 300_000,
  });

export const useSaveLeaveType = () =>
  useLeaveMutation(({ id, body }: { id: string | null; body: LeaveTypeInput }) =>
    api<LeaveTypeView>(id ? `/leave/config/types/${id}` : '/leave/config/types', {
      method: id ? 'PUT' : 'POST',
      body,
    }),
  );

export const useSaveApprovalChain = () =>
  useLeaveMutation(({ id, body }: { id: string | null; body: ApprovalChainInput }) =>
    api<ApprovalChainView>(id ? `/leave/config/chains/${id}` : '/leave/config/chains', {
      method: id ? 'PUT' : 'POST',
      body,
    }),
  );

export const useSetLeaveBalance = () =>
  useLeaveMutation((body: LeaveBalanceInput) =>
    api<void>('/leave/config/balances', { method: 'PUT', body }),
  );
