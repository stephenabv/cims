import type {
  EmployeeChange,
  EmployeeDetail,
  EmployeeListQuery,
  EmployeeSummary,
  LifecycleAction,
  PaginatedResult,
  ProvisionEmployeeInput,
  UpdateEmploymentInput,
  UpdatePersonalDetailsInput,
} from '@cims/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface Department {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  head: { id: string; fullName: string } | null;
  employeeCount: number;
}
export interface Position {
  id: string;
  title: string;
  isActive: boolean;
  department: { id: string; name: string } | null;
}
export interface AssignableRole {
  id: string;
  key: string;
  name: string;
  requiresMfa: boolean;
}

const keys = {
  all: ['employees'] as const,
  list: (q: Partial<EmployeeListQuery>) => ['employees', 'list', q] as const,
  detail: (id: string) => ['employees', 'detail', id] as const,
  history: (id: string) => ['employees', 'history', id] as const,
};

function toQueryString(q: Partial<EmployeeListQuery>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const useEmployees = (q: Partial<EmployeeListQuery>) =>
  useQuery({
    queryKey: keys.list(q),
    queryFn: () => api<PaginatedResult<EmployeeSummary>>(`/employees${toQueryString(q)}`),
    placeholderData: keepPreviousData,
  });

/** `id === 'me'` loads the signed-in employee. */
export const useEmployee = (id: string) =>
  useQuery({ queryKey: keys.detail(id), queryFn: () => api<EmployeeDetail>(`/employees/${id}`) });

export const useEmployeeHistory = (id: string, enabled = true) =>
  useQuery({
    queryKey: keys.history(id),
    queryFn: () => api<EmployeeChange[]>(`/employees/${id}/history`),
    enabled,
  });

export const useDepartments = () =>
  useQuery({
    queryKey: ['org', 'departments'],
    queryFn: () => api<Department[]>('/org/departments'),
    staleTime: 300_000,
  });
export const usePositions = () =>
  useQuery({
    queryKey: ['org', 'positions'],
    queryFn: () => api<Position[]>('/org/positions'),
    staleTime: 300_000,
  });
export const useAssignableRoles = (enabled = true) =>
  useQuery({
    queryKey: ['access', 'assignable-roles'],
    queryFn: () => api<AssignableRole[]>('/access/roles/assignable'),
    staleTime: 300_000,
    enabled,
  });

function useEmployeeMutation<TVars>(fn: (vars: TVars) => Promise<EmployeeDetail>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (detail) => {
      qc.setQueryData(keys.detail(detail.id), detail);
      void qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export const useUpdatePersonal = (id: string) =>
  useEmployeeMutation((body: UpdatePersonalDetailsInput) =>
    api<EmployeeDetail>(`/employees/${id}/personal`, { method: 'PATCH', body }),
  );
export const useUpdateEmployment = (id: string) =>
  useEmployeeMutation((body: UpdateEmploymentInput) =>
    api<EmployeeDetail>(`/employees/${id}/employment`, { method: 'PATCH', body }),
  );
export const useLifecycle = (id: string) =>
  useEmployeeMutation(({ action, reason }: { action: LifecycleAction; reason: string }) =>
    api<EmployeeDetail>(`/employees/${id}/lifecycle/${action}`, {
      method: 'POST',
      body: { reason },
    }),
  );
export const useChangeRole = (id: string) =>
  useEmployeeMutation((body: { roleId: string; reason: string }) =>
    api<EmployeeDetail>(`/employees/${id}/role`, { method: 'POST', body }),
  );

export function useProvisionEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProvisionEmployeeInput) =>
      api<{ employee: EmployeeDetail; credentialsDelivered: boolean }>('/employees', {
        method: 'POST',
        body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

export const useCredentialReset = (userId: string) =>
  useMutation({
    mutationFn: (kind: 'temporary-password' | 'pin-reset') =>
      api<{ message: string }>(`/accounts/${userId}/${kind}`, { method: 'POST' }),
  });
