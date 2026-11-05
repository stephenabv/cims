import type { CurrentUser, PermissionCode } from '@cims/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';
import { ApiError, api } from './api-client';

export const ME_QUERY_KEY = ['auth', 'me'] as const;

interface AuthState {
  user: CurrentUser | null;
  isLoading: boolean;
  /** UX-only permission check; the API is the enforcement point. */
  can: (...codes: PermissionCode[]) => boolean;
  setUser: (user: CurrentUser | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function fetchMe(): Promise<CurrentUser | null> {
  try {
    return await api<CurrentUser>('/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    staleTime: 60_000,
    retry: false,
  });

  const setUser = useCallback(
    (user: CurrentUser | null) => queryClient.setQueryData(ME_QUERY_KEY, user),
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      queryClient.clear();
      queryClient.setQueryData(ME_QUERY_KEY, null);
    }
  }, [queryClient]);

  const value = useMemo<AuthState>(() => {
    const user = data ?? null;
    const granted = new Set(user?.permissions ?? []);
    return {
      user,
      isLoading,
      can: (...codes) => codes.every((c) => granted.has(c)),
      setUser,
      logout,
    };
  }, [data, isLoading, setUser, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
