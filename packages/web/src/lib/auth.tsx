import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission } from '@opsflow/shared';
import { useQueryClient } from '@tanstack/react-query';
import { api, getToken, setToken, PASSWORD_CHANGE_REQUIRED_EVENT, type LoginResponse } from './api';

type User = LoginResponse['user'];

interface AuthValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Re-read the account from the server — after a password change, say. */
  refresh: () => Promise<void>;
  can: (permission: Permission) => boolean;
  canAny: (...permissions: Permission[]) => boolean;
  /** Account management: the flag AND the configured allowlist, checked server-side. */
  isSuperAdmin: boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  // An administrator's reset lands mid-session as a refusal on the next call;
  // re-reading the account lets the forced change-password screen take over.
  useEffect(() => {
    const onRequired = () => { void api.auth.me().then(setUser).catch(() => undefined); };
    window.addEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, onRequired);
  }, []);

  // Revalidate the stored token against the server on boot: permissions are
  // resolved server-side on every request, so a stale local copy is never
  // trusted for anything but rendering.
  useEffect(() => {
    const token = getToken();
    if (!token) { setLoading(false); return; }
    api.auth.me()
      .then(setUser)
      .catch(() => { setToken(null); setUser(null); })
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthValue>(() => ({
    user,
    loading,
    // The query cache belongs to whoever is signed in. Without clearing it, the
    // next person at a shared factory PC was shown the last one's tasks,
    // notifications and orders until each query happened to refetch.
    login: async (email, password) => {
      const res = await api.auth.login(email, password);
      queryClient.clear();
      setToken(res.token);
      setUser(res.user);
    },
    logout: () => { setToken(null); queryClient.clear(); setUser(null); },
    refresh: async () => { setUser(await api.auth.me()); },
    can: (permission) => !!user?.permissions.includes(permission),
    canAny: (...permissions) => !!user && permissions.some((p) => user.permissions.includes(p)),
    isSuperAdmin: user?.isSuperAdmin === true,
  }), [user, loading, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
