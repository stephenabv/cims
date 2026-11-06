import type {
  OvertimeDecisionInput,
  OvertimePolicy,
  OvertimeQuery,
  OvertimeRecordView,
  OvertimeSummaryQuery,
  OvertimeSummaryResult,
  PaginatedResult,
} from '@cims/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

type ListQuery = Partial<OvertimeQuery> & { page: number; pageSize: number };

export const useOvertimeList = (q: ListQuery, enabled = true) =>
  useQuery({
    queryKey: ['overtime', 'list', q],
    queryFn: () => api<PaginatedResult<OvertimeRecordView>>(`/overtime?${qs(q)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useMyOvertime = (from: string, to: string, enabled = true) =>
  useQuery({
    queryKey: ['overtime', 'mine', from, to],
    queryFn: () =>
      api<PaginatedResult<OvertimeRecordView>>(
        `/overtime/mine?${qs({ from, to, page: 1, pageSize: 100 })}`,
      ),
    enabled,
  });

export const useOvertimeWaiting = () =>
  useQuery({
    queryKey: ['overtime', 'waiting'],
    queryFn: () => api<{ count: number }>('/overtime/waiting'),
  });

export const useOvertimeSummary = (q: OvertimeSummaryQuery, enabled = true) =>
  useQuery({
    queryKey: ['overtime', 'summary', q],
    queryFn: () => api<OvertimeSummaryResult>(`/overtime/summary?${qs(q)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useOvertimePolicy = () =>
  useQuery({
    queryKey: ['overtime', 'policy'],
    queryFn: () => api<OvertimePolicy>('/overtime/policy'),
  });

export function useDecideOvertime() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: OvertimeDecisionInput }) =>
      api<OvertimeRecordView>(`/overtime/${id}/decide`, { method: 'POST', body }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['overtime'] }),
  });
}

export function useSaveOvertimePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OvertimePolicy) =>
      api<OvertimePolicy>('/overtime/policy', { method: 'PUT', body }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['overtime'] }),
  });
}
