import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission } from '@opsflow/shared';
import { api, getToken, setToken, type LoginResponse } from './api';

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
    login: async (email, password) => {
      const res = await api.auth.login(email, password);
      setToken(res.token);
      setUser(res.user);
    },
    logout: () => { setToken(null); setUser(null); },
    refresh: async () => { setUser(await api.auth.me()); },
    can: (permission) => !!user?.permissions.includes(permission),
    canAny: (...permissions) => !!user && permissions.some((p) => user.permissions.includes(p)),
    isSuperAdmin: user?.isSuperAdmin === true,
  }), [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
