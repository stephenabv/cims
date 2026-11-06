import type { KioskPunchInput, KioskPunchResult } from '@cims/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, NetworkError, api } from '@/lib/api-client';

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

const STATUS_CACHE = 'cims.kioskStatus';

/** Last status seen online, so a registered kiosk can keep taking punches after a restart offline. */
export function readCachedKioskStatus(): KioskStatus | null {
  try {
    const raw = localStorage.getItem(STATUS_CACHE);
    return raw ? (JSON.parse(raw) as KioskStatus) : null;
  } catch {
    return null;
  }
}

export const useKioskStatus = (token: string | null) =>
  useQuery({
    queryKey: kioskStatusKey(token),
    queryFn: async () => {
      const status = await api<KioskStatus>('/kiosk/status', { headers: tokenHeader(token) });
      try {
        if (status.device) localStorage.setItem(STATUS_CACHE, JSON.stringify(status));
        else localStorage.removeItem(STATUS_CACHE);
      } catch {
        /* storage unavailable */
      }
      return status;
    },
    // Re-check periodically so a revoked device stops accepting punches and the clock stays synced.
    refetchInterval: 5 * 60_000,
    // Kiosks must notice an outage themselves (to switch to the offline queue) rather than have
    // TanStack Query pause the request while the browser reports no connection.
    networkMode: 'always',
    retry: (count, err) =>
      !(err instanceof NetworkError || (err instanceof ApiError && err.status < 500)) && count < 2,
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
    // Fail fast when offline so the punch can be queued instead of silently paused.
    networkMode: 'always',
  });
