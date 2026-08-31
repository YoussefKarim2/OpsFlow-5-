/**
 * What Changed? — everything meaningful that has happened, newest first.
 *
 * The factory's day in one list. A coordinator coming back from lunch, or in on
 * Monday, wants one question answered: what did I miss. This is that answer,
 * across every order, filterable down to "what did Ahmed do to PO 13506 on
 * Tuesday".
 *
 * Two things it deliberately does not do.
 *
 * It does not paraphrase. Every line shows the actual before and after value as
 * they were stored, formatted but never rounded, summarised or guessed at. A
 * value that was never set says so instead of showing a zero.
 *
 * It does not let anyone edit history. There is no write path here at all —
 * change events are produced by the audit middleware, and the name on one is
 * the authenticated user the backend saw, not anything a browser sent.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ArrowRight, Filter, RotateCcw, Search } from 'lucide-react';
import {
  PRIORITY_STYLE, CATEGORY_LABEL,
  type NotificationPriority, type ChangeCategory,
} from '@opsflow/shared';
import { api, type ChangeEventDto } from '../lib/api';
import {
  Card, Spinner, ErrorNote, EmptyState, Avatar, Field, clsx, useDebounced,
} from '../components/ui';

const PRIORITIES: NotificationPriority[] = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];

const TONE_CLASSES: Record<NotificationPriority, { chip: string; bar: string }> = {
  URGENT: { chip: 'bg-red-50 text-red-700 ring-red-600/20', bar: 'bg-red-500' },
  HIGH: { chip: 'bg-orange-50 text-orange-700 ring-orange-600/20', bar: 'bg-orange-500' },
  NORMAL: { chip: 'bg-amber-50 text-amber-800 ring-amber-600/20', bar: 'bg-amber-400' },
  LOW: { chip: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', bar: 'bg-emerald-400' },
};

/** "10 minutes ago" — the unit a person would actually use. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Today / Yesterday / a date — the heading a person scans for. */
export function dayBucket(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (sameDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function groupByDay(events: readonly ChangeEventDto[], now = new Date()) {
  const groups: Array<{ day: string; items: ChangeEventDto[] }> = [];
  for (const e of events) {
    const day = dayBucket(e.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(e);
    else groups.push({ day, items: [e] });
  }
  return groups;
}

/**
 * `embedded` drops the page's own heading and outer padding, because when this
 * is the "What changed" tab of the Audit Log the page around it already has
 * both. Same component, same data, one place to fix a bug in it.
 */
export function WhatChangedPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [category, setCategory] = useState<ChangeCategory | 'ALL'>('ALL');
  const [priority, setPriority] = useState<NotificationPriority | 'ALL'>('ALL');
  const [actorId, setActorId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(term, 300);

  const filters = {
    ...(category !== 'ALL' ? { category } : {}),
    ...(priority !== 'ALL' ? { priority } : {}),
    ...(actorId ? { actorId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(q ? { q } : {}),
    page,
    pageSize: 50,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['changes', filters],
    queryFn: () => api.changes.list(filters),
    // Keeping the previous page on screen while the next loads stops the list
    // jumping to a spinner every time somebody touches a filter.
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const { data: options } = useQuery({
    queryKey: ['change-filters'],
    queryFn: api.changes.filters,
  });

  const anyFilter = category !== 'ALL' || priority !== 'ALL' || actorId || from || to || q;
  const reset = () => {
    setCategory('ALL'); setPriority('ALL'); setActorId('');
    setFrom(''); setTo(''); setTerm(''); setPage(1);
  };

  const change = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPage(1); };

  if (isLoading) return <Spinner label="Gathering what has changed…" />;
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={refetch} /></div>;

  const events = data?.data ?? [];
  const groups = groupByDay(events);

  return (
    <div className={clsx('space-y-4', embedded ? 'p-4' : 'p-5')}>
      {!embedded && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink-900">What changed?</h1>
            <p className="mt-0.5 text-sm text-ink-500">
              Everything meaningful that has happened, newest first — who did it, when, and what the
              value was before.
            </p>
          </div>
          {isFetching && <span className="text-2xs text-ink-400">Refreshing…</span>}
        </div>
      )}

      {/* ── Category tabs: the filter people actually use ─────────────────── */}
      <div className="flex flex-wrap gap-1.5">
        <CategoryChip
          label="All" count={data?.total} active={category === 'ALL'}
          onClick={() => change(setCategory)('ALL')}
        />
        {(Object.keys(CATEGORY_LABEL) as ChangeCategory[]).map((key) => {
          const count = options?.categories.find((c) => c.key === key)?.count;
          // A category nothing has ever happened in is a button that does
          // nothing. Hide it until it has something to show.
          if (!count && category !== key) return null;
          return (
            <CategoryChip
              key={key}
              label={CATEGORY_LABEL[key]}
              count={count}
              active={category === key}
              onClick={() => change(setCategory)(key)}
            />
          );
        })}
      </div>

      {/* ── The rest of the filters ───────────────────────────────────────── */}
      <Card>
        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Search">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
              <input
                className="input pl-8"
                placeholder="delivery, quantity, PO 13506…"
                value={term}
                onChange={(e) => { setTerm(e.target.value); setPage(1); }}
              />
            </div>
          </Field>

          <Field label="Priority">
            <select
              className="input"
              value={priority}
              onChange={(e) => change(setPriority)(e.target.value as NotificationPriority | 'ALL')}
            >
              <option value="ALL">Any priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_STYLE[p].label}
                  {options?.priorities.find((x) => x.key === p)?.count
                    ? ` (${options.priorities.find((x) => x.key === p)!.count})`
                    : ''}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Changed by">
            <select className="input" value={actorId} onChange={(e) => change(setActorId)(e.target.value)}>
              <option value="">Anyone</option>
              {(options?.actors ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.count})</option>
              ))}
            </select>
          </Field>

          <Field label="From">
            <input type="date" className="input" value={from} onChange={(e) => change(setFrom)(e.target.value)} />
          </Field>

          <Field label="To">
            <input type="date" className="input" value={to} onChange={(e) => change(setTo)(e.target.value)} />
          </Field>
        </div>

        {anyFilter && (
          <div className="flex items-center gap-2 border-t border-ink-100 bg-ink-50 px-4 py-2">
            <Filter className="h-3.5 w-3.5 text-ink-400" />
            <span className="text-xs text-ink-600">
              Showing {data?.total ?? 0} matching {data?.total === 1 ? 'change' : 'changes'}
            </span>
            <button className="btn-ghost btn-sm ml-auto" onClick={reset}>
              <RotateCcw className="h-3.5 w-3.5" /> Clear filters
            </button>
          </div>
        )}
      </Card>

      {/* ── The feed ──────────────────────────────────────────────────────── */}
      {events.length === 0 ? (
        <Card>
          <EmptyState
            title={anyFilter ? 'Nothing matches those filters' : 'Nothing has changed yet'}
            detail={
              anyFilter
                ? 'Try a wider date range, or clear the filters.'
                : 'Every meaningful change made in OpsFlow appears here — who made it, when, and the value it had before.'
            }
          />
        </Card>
      ) : (
        groups.map((group) => (
          <div key={group.day} className="space-y-2">
            <h2 className="px-1 text-2xs font-semibold uppercase tracking-wider text-ink-500">
              {group.day}
            </h2>
            <Card>
              <ul className="divide-y divide-ink-100">
                {group.items.map((e) => <ChangeRow key={e.id} event={e} />)}
              </ul>
            </Card>
          </div>
        ))
      )}

      {(data?.totalPages ?? 1) > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-500">
            Page {data!.page} of {data!.totalPages} · {data!.total} changes
          </span>
          <div className="flex gap-2">
            <button
              className="btn-secondary btn-sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <button
              className="btn-secondary btn-sm"
              disabled={page >= (data?.totalPages ?? 1)}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CategoryChip({
  label, count, active, onClick,
}: {
  label: string; count?: number; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors',
        active
          ? 'bg-accent-600 text-white ring-accent-600'
          : 'bg-white text-ink-600 ring-ink-300 hover:bg-ink-50',
      )}
    >
      {label}
      {count != null && count > 0 && (
        <span className={clsx('ml-1.5 tnum', active ? 'text-white/70' : 'text-ink-400')}>{count}</span>
      )}
    </button>
  );
}

/**
 * One change.
 *
 * The layout answers the five questions in the order somebody asks them: how
 * urgent, what happened, to which order, from what to what, and who did it.
 */
export function ChangeRow({ event, compact = false }: { event: ChangeEventDto; compact?: boolean }) {
  const tone = TONE_CLASSES[event.priority];

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', tone.bar)} title={event.priorityLabel} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="text-sm font-medium text-ink-900">{event.summary}</p>
          {event.priority !== 'LOW' && event.priority !== 'NORMAL' && (
            <span className={clsx('chip', tone.chip)}>{event.priorityLabel}</span>
          )}
          {!compact && event.orderPoNumber && (
            <Link
              to={`/orders/${event.orderId}`}
              className="font-mono text-2xs text-accent-700 hover:underline"
            >
              PO {event.orderPoNumber}
            </Link>
          )}
        </div>

        {/* Before and after, as values rather than a sentence. */}
        {event.fields.length > 0 && (
          <ul className="mt-1.5 space-y-0.5">
            {event.fields.map((f) => (
              <li key={f.field} className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                <span className="text-ink-500">{f.label}:</span>
                <span className={clsx(f.oldValue ? 'text-ink-600' : 'italic text-ink-400')}>
                  {f.oldValue ?? 'not set'}
                </span>
                <ArrowRight className="h-3 w-3 shrink-0 text-ink-300" />
                <span className={clsx('font-semibold', f.newValue ? 'text-ink-900' : 'italic text-ink-400')}>
                  {f.newValue ?? 'cleared'}
                </span>
              </li>
            ))}
          </ul>
        )}

        {event.reason && (
          <p className="mt-1 text-2xs italic text-ink-500">Reason given: {event.reason}</p>
        )}

        <div className="mt-1.5 flex items-center gap-1.5">
          <Avatar name={event.actorName} size="sm" />
          <span className="text-2xs text-ink-500">
            {event.actorName} · {relativeTime(event.createdAt)} · {event.categoryLabel}
          </span>
        </div>
      </div>

      {event.link && (
        <Link to={event.link} className="btn-ghost btn-sm shrink-0">
          Open <ArrowRight className="h-3 w-3" />
        </Link>
      )}
    </li>
  );
}
