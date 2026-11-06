import type {
  CorrectionDecisionInput,
  CorrectionRequestView,
  CorrectionStatus,
  PaginatedResult,
  SubmitCorrectionInput,
} from '@cims/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

const KEY = ['corrections'] as const;

export const useMyCorrections = (status: CorrectionStatus | undefined, page: number) =>
  useQuery({
    queryKey: [...KEY, 'mine', status ?? 'all', page],
    queryFn: () =>
      api<PaginatedResult<CorrectionRequestView>>(
        `/attendance/corrections/mine?page=${page}&pageSize=20${status ? `&status=${status}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });

export const useCorrectionApprovals = (page: number) =>
  useQuery({
    queryKey: [...KEY, 'approvals', page],
    queryFn: () =>
      api<PaginatedResult<CorrectionRequestView>>(
        `/attendance/corrections/approvals?page=${page}&pageSize=20`,
      ),
    placeholderData: keepPreviousData,
  });

function useInvalidate() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: KEY }),
      qc.invalidateQueries({ queryKey: ['attendance'] }),
      qc.invalidateQueries({ queryKey: ['notifications'] }),
    ]);
}

export function useSubmitCorrection() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: SubmitCorrectionInput) =>
      api<CorrectionRequestView>('/attendance/corrections', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useDecideCorrection() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CorrectionDecisionInput }) =>
      api<CorrectionRequestView>(`/attendance/corrections/${id}/decision`, {
        method: 'POST',
        body,
      }),
    onSuccess: invalidate,
  });
}

export function useCancelCorrection() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api<CorrectionRequestView>(`/attendance/corrections/${id}/cancel`, {
        method: 'POST',
        body: { version },
      }),
    onSuccess: invalidate,
  });
}

export const useCorrectionSettings = (enabled: boolean) =>
  useQuery({
    queryKey: [...KEY, 'settings'],
    queryFn: () => api<{ approvalChainId: string | null }>('/attendance/corrections/settings'),
    enabled,
  });

export function useSaveCorrectionSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (approvalChainId: string | null) =>
      api<void>('/attendance/corrections/settings', { method: 'PUT', body: { approvalChainId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'settings'] }),
  });
}
