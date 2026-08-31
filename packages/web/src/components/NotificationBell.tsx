/**
 * The notification bell.
 *
 * It was a link with a count on it. It is now a link with a count on it *and* a
 * panel, because the count answered "is there something?" and left the far more
 * common question — "is it anything I need to deal with right now?" — needing a
 * page load to answer.
 *
 * The badge is coloured by the loudest unread priority, so an urgent change
 * looks different from five low ones at a glance and without opening anything.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, CheckCheck } from 'lucide-react';
import { PRIORITY_STYLE, type NotificationPriority, type NotificationDto } from '@opsflow/shared';
import { api } from '../lib/api';
import { clsx } from './ui';

const BADGE_TONE: Record<NotificationPriority, string> = {
  URGENT: 'bg-red-600',
  HIGH: 'bg-orange-500',
  NORMAL: 'bg-accent-600',
  LOW: 'bg-ink-400',
};

const DOT_TONE: Record<NotificationPriority, string> = {
  URGENT: 'bg-red-500',
  HIGH: 'bg-orange-500',
  NORMAL: 'bg-amber-400',
  LOW: 'bg-emerald-400',
};

/** The loudest unread priority, which is what the badge should look like. */
export function loudestUnread(
  counts: Partial<Record<NotificationPriority, number>> | undefined,
): NotificationPriority {
  for (const p of ['URGENT', 'HIGH', 'NORMAL'] as NotificationPriority[]) {
    if ((counts?.[p] ?? 0) > 0) return p;
  }
  return 'LOW';
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: api.dashboard.notifications,
    refetchInterval: 60_000,
  });

  const markOne = useMutation({
    mutationFn: (id: string) => api.dashboard.markRead(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markAll = useMutation({
    mutationFn: api.dashboard.markAllRead,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  // Close on an outside click or Escape — a panel you cannot dismiss without
  // hitting exactly the right pixel is a panel people learn to avoid opening.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = data?.unreadCount ?? 0;
  const tone = BADGE_TONE[loudestUnread(data?.unreadByPriority)];
  const items = data?.data ?? [];

  const openItem = (n: NotificationDto) => {
    if (!n.readAt) markOne.mutate(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <div ref={wrapper} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative rounded-md p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-800"
      >
        <Bell className="h-4.5 w-4.5" />
        {unread > 0 && (
          <span
            className={clsx(
              'absolute right-1 top-1 flex h-4 min-w-[1rem] items-center justify-center',
              'rounded-full px-1 text-[9px] font-bold text-white',
              tone,
            )}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-1 w-[22rem] overflow-hidden rounded-lg border border-ink-200 bg-white shadow-panel">
          <div className="flex items-center justify-between border-b border-ink-200 px-3 py-2">
            <span className="text-sm font-semibold text-ink-900">
              Notifications{unread > 0 && <span className="ml-1.5 text-xs font-normal text-ink-500">{unread} unread</span>}
            </span>
            {unread > 0 && (
              <button
                className="btn-ghost btn-sm"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-ink-600">Nothing yet</p>
              <p className="mt-1 text-xs text-ink-500">
                Changes anyone makes in OpsFlow arrive here.
              </p>
            </div>
          ) : (
            <ul className="max-h-[26rem] divide-y divide-ink-100 overflow-y-auto">
              {items.slice(0, 12).map((n) => (
                <li key={n.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openItem(n)}
                    onKeyDown={(e) => { if (e.key === 'Enter') openItem(n); }}
                    className={clsx(
                      'flex w-full cursor-pointer items-start gap-2.5 px-3 py-2.5 text-left hover:bg-ink-50',
                      !n.readAt && 'bg-accent-50/40',
                    )}
                  >
                    <span
                      className={clsx(
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                        n.readAt ? 'bg-ink-200' : DOT_TONE[n.priority],
                      )}
                      title={PRIORITY_STYLE[n.priority]?.label ?? n.priority}
                    />
                    <div className="min-w-0 flex-1">
                      <p className={clsx('text-sm leading-snug', n.readAt ? 'text-ink-600' : 'font-medium text-ink-900')}>
                        {n.title}
                      </p>
                      {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-ink-600">{n.body}</p>}
                      <p className="mt-1 text-2xs text-ink-400">
                        {relative(n.createdAt)}
                        {n.orderPoNumber && <> · <span className="font-mono">PO {n.orderPoNumber}</span></>}
                      </p>
                    </div>
                    {!n.readAt && (
                      <button
                        className="shrink-0 rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                        aria-label="Mark read"
                        onClick={(e) => { e.stopPropagation(); markOne.mutate(n.id); }}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between border-t border-ink-200 bg-ink-50 px-3 py-2">
            <Link to="/notifications" onClick={() => setOpen(false)} className="text-xs font-medium text-accent-700 hover:underline">
              All notifications
            </Link>
            <Link to="/what-changed" onClick={() => setOpen(false)} className="text-xs font-medium text-accent-700 hover:underline">
              What changed?
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function relative(iso: string): string {
  const mins = Math.floor(Math.max(0, Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
