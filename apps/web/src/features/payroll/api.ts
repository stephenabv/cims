import type {
  CompensationListQuery,
  CompensationListRow,
  CompensationOverview,
  CompensationProfileInput,
  EmployeePayItemInput,
  EndPayItemInput,
  PaginatedResult,
  PayItemTypeInput,
  PayItemTypeView,
  PayrollPreview,
  UndertimePolicyInput,
  UndertimePolicyView,
} from '@cims/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== '' && v !== false) p.set(k, String(v));
  return p.toString();
}

export const useUndertimePolicies = () =>
  useQuery({
    queryKey: ['payroll', 'undertime-policies'],
    queryFn: () => api<UndertimePolicyView[]>('/payroll/undertime-policies'),
  });

export const usePayItemTypes = () =>
  useQuery({
    queryKey: ['payroll', 'item-types'],
    queryFn: () => api<PayItemTypeView[]>('/payroll/item-types'),
  });

export const useCompensationList = (
  q: Partial<CompensationListQuery> & { page: number; pageSize: number },
) =>
  useQuery({
    queryKey: ['payroll', 'compensation', 'list', q],
    queryFn: () => api<PaginatedResult<CompensationListRow>>(`/payroll/compensation?${qs(q)}`),
    placeholderData: keepPreviousData,
  });

export const useCompensation = (employeeId: string) =>
  useQuery({
    queryKey: ['payroll', 'compensation', employeeId],
    queryFn: () => api<CompensationOverview>(`/payroll/compensation/${employeeId}`),
  });

export const usePayPreview = (employeeId: string, from: string, to: string, enabled: boolean) =>
  useQuery({
    queryKey: ['payroll', 'compensation', employeeId, 'preview', from, to],
    queryFn: () =>
      api<PayrollPreview>(`/payroll/compensation/${employeeId}/preview?${qs({ from, to })}`),
    enabled,
    retry: false,
  });

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['payroll'] });
}

export function useCompensationMutations(employeeId: string) {
  const onSettled = useInvalidate();
  const base = `/payroll/compensation`;
  return {
    addProfile: useMutation({
      mutationFn: (body: CompensationProfileInput) =>
        api<CompensationOverview>(`${base}/${employeeId}/profiles`, { method: 'POST', body }),
      onSettled,
    }),
    removeProfile: useMutation({
      mutationFn: (id: string) => api<void>(`${base}/profiles/${id}`, { method: 'DELETE' }),
      onSettled,
    }),
    addItem: useMutation({
      mutationFn: (body: EmployeePayItemInput) =>
        api<CompensationOverview>(`${base}/${employeeId}/items`, { method: 'POST', body }),
      onSettled,
    }),
    endItem: useMutation({
      mutationFn: ({ id, body }: { id: string; body: EndPayItemInput }) =>
        api<CompensationOverview>(`${base}/items/${id}/end`, { method: 'POST', body }),
      onSettled,
    }),
    removeItem: useMutation({
      mutationFn: (id: string) => api<void>(`${base}/items/${id}`, { method: 'DELETE' }),
      onSettled,
    }),
  };
}

export function usePayrollSetupMutations() {
  const onSettled = useInvalidate();
  return {
    savePolicy: useMutation({
      mutationFn: ({ id, body }: { id: string | null; body: UndertimePolicyInput }) =>
        api<UndertimePolicyView>(
          id ? `/payroll/undertime-policies/${id}` : '/payroll/undertime-policies',
          { method: id ? 'PUT' : 'POST', body },
        ),
      onSettled,
    }),
    makeDefault: useMutation({
      mutationFn: (id: string) =>
        api<UndertimePolicyView[]>(`/payroll/undertime-policies/${id}/default`, { method: 'POST' }),
      onSettled,
    }),
    saveItemType: useMutation({
      mutationFn: ({ id, body }: { id: string | null; body: PayItemTypeInput }) =>
        api<PayItemTypeView>(id ? `/payroll/item-types/${id}` : '/payroll/item-types', {
          method: id ? 'PUT' : 'POST',
          body,
        }),
      onSettled,
    }),
  };
}
