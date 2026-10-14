import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission } from '@opsflow/shared';
import { useQueryClient } from '@tanstack/react-query';
import { api, getToken, setToken, ApiError, PASSWORD_CHANGE_REQUIRED_EVENT, type LoginResponse } from './api';

type User = LoginResponse['user'];

interface AuthValue {
  user: User | null;
  loading: boolean;
  /**
   * The server could not say who is signed in — it, or its database, was not
   * reachable. The token is kept: this is not a refusal, and clearing it sent
   * the whole factory to the sign-in screen for every ten-second outage.
   */
  unavailable: string | null;
  /** Ask the server again. */
  retry: () => void;
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
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
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
    setLoading(true);
    setUnavailable(null);
    api.auth.me()
      .then((u) => { setUser(u); setUnavailable(null); })
      .catch((err: unknown) => {
        // Only a refusal means the session is over. A 503, a 500 or no
        // response at all means the server could not answer, and the token
        // is as good as it was a minute ago.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) { setToken(null); setUser(null); return; }
        setUnavailable(err instanceof ApiError ? err.message : 'The server could not be reached.');
      })
      .finally(() => setLoading(false));
  }, [attempt]);

  // While the server is away, ask again every few seconds on our own. The
  // screen must not depend on a person pressing the button at the right
  // moment: the first attempt after the database returns can still fail on a
  // connection the pool had not yet noticed was dead.
  useEffect(() => {
    if (!unavailable || loading) return;
    const t = setTimeout(() => setAttempt((n) => n + 1), 5_000);
    return () => clearTimeout(t);
  }, [unavailable, loading, attempt]);

  const value = useMemo<AuthValue>(() => ({
    user,
    loading,
    unavailable,
    retry: () => setAttempt((n) => n + 1),
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
  }), [user, loading, unavailable, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
