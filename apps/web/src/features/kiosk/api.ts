import type { KioskPunchInput, KioskPunchResult } from '@cims/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface KioskStatus {
  device: { name: string } | null;
  acceptsPunches: boolean;
  companyName: string;
  timezone: string;
  serverTime: string;
}

const tokenHeader = (token: string | null): Record<string, string> =>
  token ? { 'X-Kiosk-Token': token } : {};

export const kioskStatusKey = (token: string | null) => ['kiosk', 'status', token] as const;

export const useKioskStatus = (token: string | null) =>
  useQuery({
    queryKey: kioskStatusKey(token),
    queryFn: () => api<KioskStatus>('/kiosk/status', { headers: tokenHeader(token) }),
    // Re-check periodically so a revoked device stops accepting punches and the clock stays synced.
    refetchInterval: 5 * 60_000,
  });

export const usePunch = (token: string | null) =>
  useMutation({
    mutationFn: (body: KioskPunchInput) =>
      api<KioskPunchResult>('/kiosk/punch', {
        method: 'POST',
        body,
        csrf: false,
        headers: tokenHeader(token),
      }),
  });
