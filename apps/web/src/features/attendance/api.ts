import type {
  AttendanceMonitorQuery,
  AttendanceMonitorResult,
  AttendanceRangeResult,
  HolidayInput,
  ScheduleInput,
} from '@cims/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface WorkSchedule {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  graceMinutes: number;
  breakMinutes: number;
  breakThresholdMinutes: number;
  days: { weekday: number; startMinute: number; endMinute: number }[];
  _count: { employees: number };
}
export interface Holiday {
  id: string;
  date: string;
  name: string;
}
export interface KioskDevice {
  id: string;
  name: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

/** `employeeId` undefined loads the signed-in employee's own attendance. */
export const useAttendanceRange = (employeeId: string | undefined, from: string, to: string) =>
  useQuery({
    queryKey: ['attendance', 'range', employeeId ?? 'me', from, to],
    queryFn: () =>
      api<AttendanceRangeResult>(
        `${employeeId ? `/attendance/employees/${employeeId}` : '/attendance/me'}?${qs({ from, to })}`,
      ),
    placeholderData: keepPreviousData,
  });

export const useAttendanceMonitor = (q: Partial<AttendanceMonitorQuery> & { date: string }) =>
  useQuery({
    queryKey: ['attendance', 'monitor', q],
    queryFn: () => api<AttendanceMonitorResult>(`/attendance/monitor?${qs(q)}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

export const useSchedules = () =>
  useQuery({ queryKey: ['schedules'], queryFn: () => api<WorkSchedule[]>('/schedules') });

export function useSaveSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: ScheduleInput }) =>
      api<WorkSchedule>(id ? `/schedules/${id}` : '/schedules', {
        method: id ? 'PUT' : 'POST',
        body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  });
}

export function useAssignSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, scheduleId }: { employeeId: string; scheduleId: string | null }) =>
      api<void>(`/employees/${employeeId}/schedule`, { method: 'PUT', body: { scheduleId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['schedules'] });
      void qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}

export const useHolidays = (year: number) =>
  useQuery({ queryKey: ['holidays', year], queryFn: () => api<Holiday[]>(`/holidays/${year}`) });

export function useHolidayMutations() {
  const qc = useQueryClient();
  const onSuccess = () => {
    void qc.invalidateQueries({ queryKey: ['holidays'] });
    void qc.invalidateQueries({ queryKey: ['attendance'] });
  };
  return {
    add: useMutation({
      mutationFn: (body: HolidayInput) => api<Holiday>('/holidays', { method: 'POST', body }),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api<void>(`/holidays/${id}`, { method: 'DELETE' }),
      onSuccess,
    }),
  };
}

export const useKioskDevices = () =>
  useQuery({ queryKey: ['kiosk-devices'], queryFn: () => api<KioskDevice[]>('/kiosk-devices') });

export function useKioskDeviceMutations() {
  const qc = useQueryClient();
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['kiosk-devices'] });
  return {
    register: useMutation({
      mutationFn: (name: string) =>
        api<{ id: string; name: string; token: string }>('/kiosk-devices', {
          method: 'POST',
          body: { name },
        }),
      onSuccess,
    }),
    revoke: useMutation({
      mutationFn: (id: string) => api<void>(`/kiosk-devices/${id}/revoke`, { method: 'POST' }),
      onSuccess,
    }),
  };
}
