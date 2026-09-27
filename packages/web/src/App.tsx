import { lazy, Suspense, type ComponentType } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Permission } from '@opsflow/shared';
import { AuthProvider, useAuth } from './lib/auth';
import { AppShell } from './components/AppShell';
import { Spinner, ToastProvider, EmptyState } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';

import { OrdersPage } from './pages/Orders';
import { ForcedPasswordChangePage } from './pages/ChangePassword';

// The larger screens load when first opened. As one bundle the app was 1.1 MB
// of JavaScript before the sign-in page could draw, most of it charts and
// order tabs that a given visit may never reach.
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const DashboardPage = named(() => import('./pages/Dashboard'), 'DashboardPage');
const OrderWorkspacePage = named(() => import('./pages/OrderWorkspace'), 'OrderWorkspacePage');
const FollowUpPage = named(() => import('./pages/FollowUp'), 'FollowUpPage');
const WhatChangedPage = named(() => import('./pages/WhatChanged'), 'WhatChangedPage');
const UsersPage = named(() => import('./pages/admin/UsersPage'), 'UsersPage');
const AuditLogPage = named(() => import('./pages/admin/AuditLogPage'), 'AuditLogPage');
const MaterialsPage = named(() => import('./pages/inventory/MaterialsPage'), 'MaterialsPage');
const MaterialDetailPage = named(() => import('./pages/inventory/MaterialDetailPage'), 'MaterialDetailPage');
const ReservationsPage = named(() => import('./pages/inventory/MaterialDetailPage'), 'ReservationsPage');
const MovementsPage = named(() => import('./pages/inventory/MaterialDetailPage'), 'MovementsPage');
const ImportWizardPage = named(() => import('./pages/ImportWizard'), 'ImportWizardPage');
import {
  LoginPage, MyTasksPage, NotificationsPage, ReportsPage,
  ModuleListPage, ClientsPage, FactoriesPage, SettingsPage,
} from './pages/Misc';

const queryClient: QueryClient = new QueryClient({
  // The step rail is derived from nearly everything on an order — production,
  // audits, cartons, shipments, the BOM, external work, costing, tasks — and
  // listing it in every one of those mutations is how some were missed and the
  // rail went stale. Any successful write marks it stale instead. Only the rail
  // on screen refetches, so this costs one small request.
  mutationCache: new MutationCache({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['order-steps'] });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        // Don't retry a refusal — a 403 or a business-rule 409 will not
        // succeed on the second attempt, and retrying hides the message.
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

/**
 * `requires` hides a page the account cannot use. It is a courtesy, not a
 * control: every endpoint behind these pages enforces the same rule again, and
 * a user who types the URL gets an explanation rather than a blank screen.
 */
function Protected({ children, requires }: { children: React.ReactNode; requires?: Permission }) {
  const { user, loading, can } = useAuth();
  const location = useLocation();

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner label="Signing in…" /></div>;
  if (!user) return <Navigate to="/login" replace />;

  // The API refuses everything else until the password is changed, so showing
  // the app underneath would only produce a wall of 403s.
  if (user.mustChangePassword) return <ForcedPasswordChangePage />;

  if (requires && !can(requires)) {
    return (
      <AppShell>
        <div className="p-8">
          <EmptyState
            title="You do not have access to this page"
            detail={`It needs the "${requires}" permission. Ask an administrator if you should have it.`}
          />
        </div>
      </AppShell>
    );
  }

  // The boundary sits *inside* the shell so a screen that fails to render
  // leaves the sidebar and the header working — the user can walk away from
  // the broken page instead of being trapped on it. Keyed by path so that
  // walking away actually clears the error rather than carrying it along.
  return (
    <AppShell>
      <ErrorBoundary key={location.pathname}>
        <Suspense fallback={<Spinner />}>{children}</Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            <Route path="/" element={<Protected><DashboardPage /></Protected>} />
            <Route path="/orders" element={<Protected><OrdersPage /></Protected>} />
            <Route path="/orders/:id" element={<Protected><OrderWorkspacePage /></Protected>} />
            <Route path="/my-tasks" element={<Protected><MyTasksPage /></Protected>} />
            <Route path="/follow-up" element={<Protected><FollowUpPage /></Protected>} />
            <Route path="/notifications" element={<Protected><NotificationsPage /></Protected>} />
            {/* Not in the sidebar any more: it is the friendly half of the
                Audit Log, and lives there as a tab. The route stays because
                the notification bell links straight to it. */}
            <Route path="/what-changed" element={<Protected requires="order:read"><WhatChangedPage /></Protected>} />

            {/*
              The six department pages that used to live in the sidebar.
              Each was the order list with one status filter, and each implied
              that work happened there rather than inside an order. They are
              now redirects, so an old bookmark or a link in somebody's email
              still lands somewhere sensible instead of on a 404.
            */}
            <Route path="/production" element={<Navigate to="/orders?status=IN_PRODUCTION" replace />} />
            <Route path="/materials"  element={<Navigate to="/orders" replace />} />
            <Route path="/external"   element={<Navigate to="/orders" replace />} />
            <Route path="/quality"    element={<Navigate to="/orders?status=QUALITY_CHECK" replace />} />
            <Route path="/packing"    element={<Navigate to="/orders?status=PACKING" replace />} />
            <Route path="/shipping"   element={<Navigate to="/orders?status=READY_TO_SHIP" replace />} />

            <Route path="/costing" element={
              <Protected requires="costing:read">
                <ModuleListPage
                  title="Costing" subtitle="Actual cost against selling price"
                  columns={['qty', 'shipped']}
                />
              </Protected>
            } />

            {/* Inventory — the factory's own stock, as opposed to one order's BOM. */}
            <Route path="/inventory" element={<Navigate to="/inventory/materials" replace />} />
            <Route path="/inventory/materials" element={<Protected requires="material:read"><MaterialsPage /></Protected>} />
            <Route path="/inventory/materials/:id" element={<Protected requires="material:read"><MaterialDetailPage /></Protected>} />
            <Route path="/inventory/reservations" element={<Protected requires="material:read"><ReservationsPage /></Protected>} />
            <Route path="/inventory/movements" element={<Protected requires="material:read"><MovementsPage /></Protected>} />

            {/* Administration */}
            <Route path="/admin/users" element={<Protected requires="user:manage"><UsersPage /></Protected>} />
            <Route path="/admin/audit" element={<Protected requires="audit:read"><AuditLogPage /></Protected>} />

            <Route path="/clients" element={<Protected><ClientsPage /></Protected>} />
            <Route path="/factories" element={<Protected><FactoriesPage /></Protected>} />
            <Route path="/reports" element={<Protected><ReportsPage /></Protected>} />
            <Route path="/import" element={<Protected requires="import:run"><ImportWizardPage /></Protected>} />
            <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
