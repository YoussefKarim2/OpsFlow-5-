import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Permission } from '@opsflow/shared';
import { AuthProvider, useAuth } from './lib/auth';
import { AppShell } from './components/AppShell';
import { Spinner, ToastProvider, EmptyState } from './components/ui';

import { DashboardPage } from './pages/Dashboard';
import { OrdersPage } from './pages/Orders';
import { OrderWorkspacePage } from './pages/OrderWorkspace';
import { FollowUpPage } from './pages/FollowUp';
import { WhatChangedPage } from './pages/WhatChanged';
import { ForcedPasswordChangePage } from './pages/ChangePassword';
import { UsersPage } from './pages/admin/UsersPage';
import { AuditLogPage } from './pages/admin/AuditLogPage';
import { MaterialsPage } from './pages/inventory/MaterialsPage';
import { MaterialDetailPage, ReservationsPage, MovementsPage } from './pages/inventory/MaterialDetailPage';
import { ImportWizardPage } from './pages/ImportWizard';
import {
  LoginPage, MyTasksPage, NotificationsPage, ReportsPage,
  ModuleListPage, ClientsPage, FactoriesPage, SettingsPage,
} from './pages/Misc';

const queryClient = new QueryClient({
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

  return <AppShell>{children}</AppShell>;
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
            <Route path="/materials"  element={<Navigate to="/orders?shortages=1" replace />} />
            <Route path="/external"   element={<Navigate to="/orders?external=1" replace />} />
            <Route path="/quality"    element={<Navigate to="/orders?status=QUALITY_CHECK" replace />} />
            <Route path="/packing"    element={<Navigate to="/orders?status=PACKING" replace />} />
            <Route path="/shipping"   element={<Navigate to="/orders?status=READY_TO_SHIP" replace />} />

            <Route path="/costing" element={
              <Protected>
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
