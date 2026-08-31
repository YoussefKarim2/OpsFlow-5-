import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, Package, CheckSquare, Boxes, ShieldCheck,
  DollarSign, Users, Building2, BarChart3, Settings, Search,
  LogOut, Menu, X, ListChecks, Upload, UserCog, ScrollText,
  BookLock, ArrowLeftRight,
} from 'lucide-react';
import type { Permission } from '@opsflow/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, clsx, useDebounced } from './ui';
import { NotificationBell } from './NotificationBell';

/**
 * `requires` removes an item the account cannot use, so nobody is offered a
 * button that answers with a 403. The permission is still checked on the route
 * and again on every endpoint behind it — this is presentation, not security.
 */
const NAV: Array<{
  to: string; label: string; icon: typeof LayoutDashboard; group: string; requires?: Permission;
}> = [
  { to: '/',            label: 'Dashboard',      icon: LayoutDashboard, group: 'Overview' },
  { to: '/orders',      label: 'Orders',         icon: Package,         group: 'Overview' },
  { to: '/my-tasks',    label: 'My Tasks',       icon: CheckSquare,     group: 'Overview' },
  { to: '/follow-up',   label: 'Follow-Up',      icon: ListChecks,      group: 'Overview' },

  // The factory's own stock, as distinct from what one order needs.
  { to: '/inventory/materials',    label: 'Materials',    icon: Boxes,     group: 'Inventory', requires: 'material:read' },
  { to: '/inventory/reservations', label: 'Reservations', icon: BookLock,  group: 'Inventory', requires: 'material:read' },
  { to: '/inventory/movements',    label: 'Movements',    icon: ArrowLeftRight, group: 'Inventory', requires: 'material:read' },

  // NOTE: there is deliberately no "Production", "Quality", "Packing",
  // "Shipping", "External Ops" or "Order BOM" group here any more.
  //
  // Each of those was the same order list with a different status filter — six
  // sidebar entries that all answered "which orders are in this state", which
  // is a question the Orders page answers with a dropdown. Worse, they read as
  // though they were places where work happens, when the work happens inside an
  // order. Their routes still exist and redirect to Orders with the filter
  // applied, so old links and bookmarks keep working.
  //
  // Everything those pages used to show now lives where it belongs: in the
  // order's own eighteen steps.

  { to: '/costing',     label: 'Costing',        icon: DollarSign,      group: 'Business', requires: 'costing:read' },
  { to: '/clients',     label: 'Clients',        icon: Users,           group: 'Business' },
  { to: '/factories',   label: 'Factories',      icon: Building2,       group: 'Business' },
  { to: '/reports',     label: 'Reports',        icon: BarChart3,       group: 'Business', requires: 'report:read' },
  { to: '/import',      label: 'Excel Import',   icon: Upload,          group: 'Business', requires: 'import:run' },

  { to: '/admin/users', label: 'Users',          icon: UserCog,         group: 'Administration', requires: 'user:manage' },
  { to: '/admin/audit', label: 'Audit Log',      icon: ScrollText,      group: 'Administration', requires: 'audit:read' },
  { to: '/settings',    label: 'Settings',       icon: Settings,        group: 'Administration' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();

  const visible = NAV.filter((n) => !n.requires || can(n.requires));
  const groups = [...new Set(visible.map((n) => n.group))];

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-ink-800 bg-ink-950 transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-ink-800 px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-accent-600 text-sm font-bold text-white">
            OF
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">OpsFlow</p>
            <p className="truncate text-2xs text-ink-400">Order Control Centre</p>
          </div>
          <button className="ml-auto text-ink-400 lg:hidden" onClick={() => setOpen(false)}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {groups.map((group) => (
            <div key={group} className="mb-4">
              <p className="mb-1 px-2 text-2xs font-semibold uppercase tracking-wider text-ink-500">{group}</p>
              {visible.filter((n) => n.group === group).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    clsx(
                      'mb-0.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-accent-600/15 font-medium text-accent-200'
                        : 'text-ink-300 hover:bg-ink-900 hover:text-white',
                    )
                  }
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-ink-800 p-3">
          <div className="flex items-center gap-2.5">
            <Avatar name={user?.name ?? '?'} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{user?.name}</p>
              <p className="flex items-center gap-1 truncate text-2xs text-ink-400">
                {user?.isSuperAdmin && <ShieldCheck className="h-3 w-3 shrink-0 text-accent-400" />}
                <span className="truncate">{user?.roleLabel}</span>
              </p>
            </div>
            <button
              onClick={() => { logout(); navigate('/login'); }}
              className="rounded p-1.5 text-ink-400 hover:bg-ink-900 hover:text-white"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {open && <div className="fixed inset-0 z-30 bg-ink-950/50 lg:hidden" onClick={() => setOpen(false)} />}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-ink-200 bg-white px-4">
          <button className="text-ink-500 lg:hidden" onClick={() => setOpen(true)}>
            <Menu className="h-5 w-5" />
          </button>

          <GlobalSearch />

          <div className="ml-auto flex items-center gap-1">
            <NotificationBell />
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

/**
 * Global search — the brief's section 37. Matches PO, order name, style,
 * client, coordinator, factory and external reference in one box.
 */
function GlobalSearch() {
  const [term, setTerm] = useState('');
  const [focused, setFocused] = useState(false);
  const debounced = useDebounced(term, 250);
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.orders.search(debounced),
    enabled: debounced.trim().length >= 2,
  });

  const results = data?.data ?? [];
  const show = focused && debounced.trim().length >= 2;

  return (
    <div className="relative max-w-md flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="Search PO, order, client, style, coordinator…"
        className="input pl-8"
      />
      {show && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-md border border-ink-200 bg-white shadow-panel">
          {results.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-ink-500">No orders match “{debounced}”.</p>
          ) : (
            results.map((o) => (
              <button
                key={o.id}
                onMouseDown={() => { navigate(`/orders/${o.id}`); setTerm(''); }}
                className="flex w-full items-center gap-3 border-b border-ink-100 px-3 py-2 text-left last:border-0 hover:bg-ink-50"
              >
                <span className="font-mono text-xs font-semibold text-accent-700">{o.poNumber}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-800">{o.orderName}</span>
                <span className="truncate text-xs text-ink-500">{o.clientName}</span>
                <span className="tnum text-xs text-ink-400">{o.progressPct}%</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
