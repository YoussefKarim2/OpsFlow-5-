import { useState, type ReactNode } from 'react';
import { OutageBanner } from './OutageBanner';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, Package, Boxes, ShieldCheck,
  DollarSign, BarChart3, Settings, Search,
  LogOut, Menu, X, ListChecks, Upload, UserCog, ScrollText,
  BookLock, ArrowLeftRight, Activity, Receipt,
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
  { to: '/productivity', label: 'Productivity',  icon: Activity,        group: 'Overview', requires: 'production:read' },
  { to: '/orders',      label: 'Orders',         icon: Package,         group: 'Overview' },
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
  { to: '/invoices',    label: 'Proforma / Invoice', icon: Receipt,     group: 'Business', requires: 'invoice:read' },
  { to: '/reports',     label: 'Reports',        icon: BarChart3,       group: 'Business', requires: 'report:read' },
  { to: '/import',      label: 'Import Document', icon: Upload,          group: 'Business', requires: 'import:run' },

  { to: '/admin/users', label: 'Users',          icon: UserCog,         group: 'Administration', requires: 'user:manage' },
  { to: '/admin/audit', label: 'Audit Log',      icon: ScrollText,      group: 'Administration', requires: 'audit:read' },
  { to: '/settings',    label: 'Settings',       icon: Settings,        group: 'Administration' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();

  // Orders is the most used screen and the widest one, so there the sidebar
  // shrinks to its icons on desktop: the page gets the room, and the labels
  // stop crowding each other. Each icon keeps its name as a tooltip and for
  // screen readers. The phone drawer keeps its labels: it slides over the
  // page and takes no width from it.
  const { pathname } = useLocation();
  const compact = pathname === '/orders' || pathname.startsWith('/orders/');
  // Narrowing is one movement: the sidebar and the page's left edge move
  // together on the same curve, icons keep their left edge, labels fade where
  // they are, and nothing swaps alignment halfway.
  const ease = 'duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none';

  const visible = NAV.filter((n) => !n.requires || can(n.requires));
  const groups = [...new Set(visible.map((n) => n.group))];

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col overflow-hidden border-r border-ink-800 bg-ink-950 transition-[transform,width] lg:translate-x-0',
          ease,
          open ? 'translate-x-0' : '-translate-x-full',
          compact && 'lg:w-16',
        )}
      >
        {/* 18px in from the edge: the logo's centre is the narrow bar's centre. */}
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-ink-800 px-[18px]">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-accent-600 text-sm font-bold text-white" title={compact ? 'OpsFlow' : undefined}>
            OF
          </div>
          <div className={clsx('min-w-0 whitespace-nowrap transition-opacity', ease, compact && 'lg:opacity-0')}>
            <p className="truncate text-sm font-semibold text-white">OpsFlow</p>
            <p className="truncate text-2xs text-ink-400">Order Control Centre</p>
          </div>
          <button className="ml-auto text-ink-400 lg:hidden" onClick={() => setOpen(false)}>
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrolls when it must, without a scrollbar: in the narrow bar one
            takes a quarter of the width and pushes every icon off centre. */}
        <nav className={clsx('flex-1 overflow-y-auto px-2 py-3 transition-[padding] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', ease, compact && 'lg:py-2')}>
          {groups.map((group, gi) => (
            <div key={group} className={clsx('transition-[margin]', ease, compact ? 'mb-4 lg:mb-1' : 'mb-4')}>
              <p className={clsx(
                'max-h-4 overflow-hidden whitespace-nowrap px-2 text-2xs font-semibold uppercase tracking-wider text-ink-500 transition-[max-height,margin,opacity]',
                ease, compact ? 'mb-1 lg:mb-0 lg:max-h-0 lg:opacity-0' : 'mb-1',
              )}>{group}</p>
              {/* Icon-only: a thin rule fades in where the group heading was. */}
              {gi > 0 && (
                <div aria-hidden className={clsx(
                  'mx-2 hidden border-t transition-[border-color,margin] lg:block', ease,
                  compact ? 'mb-1.5 border-ink-800' : 'mb-0 border-transparent',
                )} />
              )}
              {visible.filter((n) => n.group === group).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  onClick={() => setOpen(false)}
                  title={compact ? item.label : undefined}
                  className={({ isActive }) =>
                    clsx(
                      'mb-0.5 flex items-center gap-2.5 whitespace-nowrap rounded-md px-2 py-1.5 text-sm transition-[padding,background-color,color]',
                      ease,
                      // 12px in, so a 24px icon sits on the narrow bar's centre.
                      compact && 'lg:py-1 lg:pl-3',
                      isActive
                        ? 'bg-accent-600/15 font-medium text-accent-200'
                        : 'text-ink-300 hover:bg-ink-900 hover:text-white',
                    )
                  }
                >
                  {/* 24px when narrow, the icons' own grid, drawn with a 1.5px line
                      rather than the default 2px so the larger icons stay as light
                      as the small ones beside the labels. */}
                  <item.icon className={clsx('h-4 w-4 shrink-0 transition-[width,height,stroke-width]', ease, compact && 'lg:h-6 lg:w-6 lg:[stroke-width:1.5]')} />
                  <span className={clsx('truncate transition-opacity', ease, compact && 'lg:opacity-0')}>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className={clsx('shrink-0 border-t border-ink-800 p-3', compact && 'lg:px-0')}>
          <div className={clsx('flex items-center gap-2.5', compact && 'lg:flex-col lg:gap-1.5')}>
            <span title={compact ? `${user?.name ?? ''} · ${user?.roleLabel ?? ''}` : undefined}><Avatar name={user?.name ?? '?'} /></span>
            <div className={clsx('min-w-0 flex-1', compact && 'lg:hidden')}>
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
      <div className={clsx('flex min-w-0 flex-1 flex-col transition-[padding] print:!pl-0', ease, compact ? 'lg:pl-16' : 'lg:pl-60')}>
        <header className="no-print sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-ink-200 bg-white px-4">
          <button className="text-ink-500 lg:hidden" onClick={() => setOpen(true)}>
            <Menu className="h-5 w-5" />
          </button>

          <GlobalSearch />

          <div className="ml-auto flex items-center gap-1">
            <NotificationBell />
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto"><OutageBanner />{children}</main>
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
