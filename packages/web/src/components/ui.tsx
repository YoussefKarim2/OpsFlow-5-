/**
 * Shared UI primitives.
 *
 * Two of these carry real domain meaning rather than being generic widgets:
 * `Num`, which is the only sanctioned way to render a number (so a null can
 * never surface as NaN or "#DIV/0!"), and `FreeText`, which sets text direction
 * from the content because half the notes in this system are Arabic.
 */

import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { X } from 'lucide-react';
import {
  fmtNumber, fmtMoney, fmtPct, fmtVariance, isArabic,
  HEALTH_STYLE, SEVERITY_STYLE, ORDER_STATUS_LABEL,
  type Health, type OrderStatus, type AlertSeverity, type Priority, type StageStatus,
} from '@opsflow/shared';

// ── Numbers ─────────────────────────────────────────────────────────────────

/**
 * The single place a number becomes text.
 *
 * Everything nullable renders as "Not calculated" (or a supplied fallback)
 * rather than NaN, Infinity or an Excel error string. This is the UI half of
 * the guarantee that `safeDiv` makes in the calculation engine.
 */
export function Num({
  value, kind = 'number', places, suffix, fallback, className,
}: {
  value: number | null | undefined;
  kind?: 'number' | 'money' | 'percent' | 'variance';
  places?: number;
  suffix?: string;
  fallback?: string;
  className?: string;
}) {
  const text =
    kind === 'money' ? fmtMoney(value, '$', places ?? 2)
    : kind === 'percent' ? fmtPct(value, places ?? 0)
    : kind === 'variance' ? fmtVariance(value)
    : fmtNumber(value, { places: places ?? 0, suffix: suffix ?? '' });

  const unavailable = value == null || !Number.isFinite(value);
  const display = unavailable && fallback ? fallback : text;

  return (
    <span
      className={clsx(
        'tnum',
        unavailable && 'text-ink-400 italic',
        kind === 'variance' && !unavailable && value !== 0 && (value! > 0 ? 'text-emerald-600' : 'text-red-600'),
        className,
      )}
      title={unavailable ? 'Not enough information to calculate this yet' : undefined}
    >
      {display}
    </span>
  );
}

/** Free text that may be Arabic — direction is set from the content. */
export function FreeText({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text?.trim()) return <span className="text-ink-400">—</span>;
  const rtl = isArabic(text);
  return (
    <span
      dir={rtl ? 'rtl' : 'ltr'}
      lang={rtl ? 'ar' : undefined}
      className={clsx('rtl-aware whitespace-pre-line', rtl && 'block text-right', className)}
    >
      {text}
    </span>
  );
}

// ── Badges ──────────────────────────────────────────────────────────────────

export function HealthBadge({ health, className }: { health: Health; className?: string }) {
  const s = HEALTH_STYLE[health];
  return (
    <span className={clsx('chip', s.chip, className)}>
      <span className={clsx('h-1.5 w-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  );
}

const STATUS_TONE: Record<OrderStatus, string> = {
  DRAFT: 'bg-ink-100 text-ink-600 ring-ink-500/20',
  WAITING_APPROVAL: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  READY_FOR_PRODUCTION: 'bg-teal-50 text-teal-700 ring-teal-600/20',
  IN_PRODUCTION: 'bg-accent-50 text-accent-700 ring-accent-600/20',
  PRODUCTION_DELAYED: 'bg-red-50 text-red-700 ring-red-600/20',
  QUALITY_CHECK: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  QUALITY_BLOCKED: 'bg-red-50 text-red-700 ring-red-600/20',
  PACKING: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  READY_TO_SHIP: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  SHIPPED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  COMPLETED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  CANCELLED: 'bg-ink-100 text-ink-500 ring-ink-500/20',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={clsx('chip', STATUS_TONE[status])}>{ORDER_STATUS_LABEL[status]}</span>;
}

const PRIORITY_TONE: Record<Priority, string> = {
  LOW: 'bg-ink-100 text-ink-600 ring-ink-500/20',
  MEDIUM: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  HIGH: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  URGENT: 'bg-red-50 text-red-700 ring-red-600/20',
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={clsx('chip', PRIORITY_TONE[priority])}>{priority}</span>;
}

export function SeverityDot({ severity }: { severity: AlertSeverity }) {
  return <span className={clsx('inline-block h-2 w-2 shrink-0 rounded-full', SEVERITY_STYLE[severity].bar)} />;
}

const STAGE_TONE: Record<StageStatus, { icon: string; cls: string; label: string }> = {
  COMPLETED:   { icon: '✓', cls: 'bg-emerald-500 text-white',           label: 'Completed' },
  IN_PROGRESS: { icon: '●', cls: 'bg-accent-500 text-white',            label: 'In progress' },
  WAITING:     { icon: '◐', cls: 'bg-blue-400 text-white',              label: 'Waiting' },
  BLOCKED:     { icon: '!', cls: 'bg-red-500 text-white',               label: 'Blocked' },
  OVERDUE:     { icon: '!', cls: 'bg-orange-500 text-white',            label: 'Overdue' },
  NOT_STARTED: { icon: '', cls: 'border border-ink-300 bg-white text-ink-400', label: 'Not started' },
  // Grey and dashed, never a tick. A step this order does not need is not a
  // step somebody finished, and showing it as done would inflate progress.
  NOT_REQUIRED: { icon: '–', cls: 'border border-dashed border-ink-300 bg-ink-50 text-ink-400', label: 'Not required' },
};

export function StageDot({ status, size = 'md' }: { status: StageStatus; size?: 'sm' | 'md' }) {
  const t = STAGE_TONE[status];
  return (
    <span
      title={t.label}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none',
        size === 'sm' ? 'h-4 w-4 text-[9px]' : 'h-6 w-6 text-[11px]',
        t.cls,
      )}
    >
      {t.icon}
    </span>
  );
}

// ── Progress ────────────────────────────────────────────────────────────────

export function ProgressBar({
  value, className, tone = 'auto', showLabel = false, height = 'md',
}: {
  value: number | null;
  className?: string;
  tone?: 'auto' | 'accent' | 'emerald' | 'amber' | 'red';
  showLabel?: boolean;
  height?: 'sm' | 'md' | 'lg';
}) {
  const pct = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value));
  const resolved =
    tone !== 'auto' ? tone
    : pct >= 90 ? 'emerald'
    : pct >= 50 ? 'accent'
    : pct > 0 ? 'amber'
    : 'red';

  const fill = {
    accent: 'bg-accent-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-400',
  }[resolved];

  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className={clsx('flex-1 overflow-hidden rounded-full bg-ink-200', { sm: 'h-1', md: 'h-1.5', lg: 'h-2.5' }[height])}>
        <div className={clsx('h-full rounded-full transition-all duration-500', fill)} style={{ width: `${pct}%` }} />
      </div>
      {showLabel && <span className="tnum w-9 text-right text-xs font-semibold text-ink-600">{Math.round(pct)}%</span>}
    </div>
  );
}

// ── Layout primitives ───────────────────────────────────────────────────────

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('card', className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card-header">
      <div className="min-w-0">
        <h3 className="card-title truncate">{title}</h3>
        {subtitle && <p className="mt-0.5 truncate text-xs text-ink-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function StatTile({
  label, value, sub, tone = 'neutral', icon, onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'accent' | 'emerald' | 'amber' | 'red' | 'blue';
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const tones = {
    neutral: 'border-ink-200',
    accent: 'border-accent-200 bg-accent-50/40',
    emerald: 'border-emerald-200 bg-emerald-50/40',
    amber: 'border-amber-200 bg-amber-50/40',
    red: 'border-red-200 bg-red-50/40',
    blue: 'border-blue-200 bg-blue-50/40',
  };
  const valueTone = {
    neutral: 'text-ink-900', accent: 'text-accent-700', emerald: 'text-emerald-700',
    amber: 'text-amber-700', red: 'text-red-700', blue: 'text-blue-700',
  };

  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={clsx(
        'rounded-lg border bg-white p-3 text-left shadow-card transition',
        tones[tone],
        onClick && 'hover:border-ink-300 hover:shadow-panel',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-2xs font-semibold uppercase tracking-wider text-ink-500">{label}</p>
        {icon && <span className="text-ink-400">{icon}</span>}
      </div>
      <p className={clsx('tnum mt-1.5 text-2xl font-semibold leading-none', valueTone[tone])}>{value}</p>
      {sub && <p className="mt-1.5 text-xs text-ink-500">{sub}</p>}
    </Tag>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {detail && <p className="mt-1 max-w-sm text-xs text-ink-500">{detail}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-300 border-t-accent-600" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
      <p className="font-medium">{message}</p>
      {onRetry && <button className="btn-ghost btn-sm mt-1 text-red-700" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Modal({
  open, onClose, title, subtitle, children, footer, wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4 pt-[6vh]">
      <div className="absolute inset-0" onClick={onClose} aria-hidden />
      <div className={clsx('relative w-full rounded-lg bg-white shadow-panel', wide ? 'max-w-4xl' : 'max-w-lg')}>
        <div className="flex items-start justify-between gap-4 border-b border-ink-200 px-5 py-3.5">
          <div>
            <h2 className="text-base font-semibold text-ink-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-ink-200 bg-ink-50 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation for an action that is awkward or impossible to undo.
 *
 * `requireTyped` raises the bar for the genuinely dangerous ones: the person
 * types the account's email before the button unlocks, which makes "disable the
 * wrong row" a mistake you have to work at.
 */
export function ConfirmDialog({
  open, onCancel, onConfirm, title, body, confirmLabel = 'Confirm',
  tone = 'danger', busy = false, requireTyped, children,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  /** When set, the confirm button stays disabled until this string is typed. */
  requireTyped?: string;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');

  useEffect(() => { if (open) setTyped(''); }, [open]);

  const unlocked = !requireTyped || typed.trim().toLowerCase() === requireTyped.trim().toLowerCase();

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className={tone === 'danger' ? 'btn-danger' : 'btn-primary'}
            onClick={onConfirm}
            disabled={busy || !unlocked}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {typeof body === 'string' ? <p className="text-sm text-ink-700">{body}</p> : body}
        {children}
        {requireTyped && (
          <Field label={`Type ${requireTyped} to confirm`}>
            <input
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ── Toasts ──────────────────────────────────────────────────────────────────

interface Toast { id: number; kind: 'success' | 'error' | 'info'; message: string }

const ToastContext = createContext<{ push: (kind: Toast['kind'], message: string) => void } | null>(null);

/**
 * Success and failure notices for actions that leave the page where it was.
 * Errors linger twice as long as successes: nobody needs to re-read "Saved".
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const value = useMemo(() => ({
    push: (kind: Toast['kind'], message: string) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t, { id, kind, message }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
    },
  }), []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={clsx(
              'pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm shadow-panel',
              t.kind === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-900',
              t.kind === 'error' && 'border-red-200 bg-red-50 text-red-900',
              t.kind === 'info' && 'border-ink-200 bg-white text-ink-800',
            )}
          >
            <span className="flex-1">{t.message}</span>
            <button
              className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
              onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Never throws when there is no provider: a component that reports a result
 * should not be the reason a page fails to render.
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  return useMemo(() => ({
    success: (m: string) => ctx?.push('success', m),
    error: (e: unknown) => ctx?.push('error', e instanceof Error ? e.message : String(e)),
    info: (m: string) => ctx?.push('info', m),
  }), [ctx]);
}

/** A value the user must copy now because it will not be shown again. */
export function CopyableSecret({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
      {label && <p className="mb-1 text-xs font-medium text-amber-900">{label}</p>}
      <div className="flex items-center gap-2">
        <code className="flex-1 select-all break-all rounded bg-white px-2 py-1.5 font-mono text-sm text-ink-900 ring-1 ring-inset ring-amber-200">
          {value}
        </code>
        <button
          className="btn-secondary btn-sm shrink-0"
          onClick={() => {
            navigator.clipboard?.writeText(value).then(
              () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
              () => undefined,
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-2xs text-ink-500">{hint}</p>}
    </div>
  );
}

/** Small tab strip, used inside cards and on the order workspace. */
export function TabStrip<T extends string>({
  tabs, active, onChange,
}: {
  tabs: Array<{ key: T; label: string; badge?: number | string; tone?: 'red' | 'amber' | 'default' }>;
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex gap-0.5 overflow-x-auto border-b border-ink-200">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={clsx(
            'relative whitespace-nowrap px-3 py-2 text-sm font-medium transition-colors',
            active === t.key
              ? 'text-accent-700 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent-600'
              : 'text-ink-500 hover:text-ink-800',
          )}
        >
          {t.label}
          {t.badge != null && t.badge !== 0 && (
            <span
              className={clsx(
                'ml-1.5 inline-flex min-w-[1.15rem] items-center justify-center rounded-full px-1 py-px text-2xs font-semibold',
                t.tone === 'red' ? 'bg-red-100 text-red-700'
                : t.tone === 'amber' ? 'bg-amber-100 text-amber-800'
                : 'bg-ink-100 text-ink-600',
              )}
            >
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/** Avatar from initials — no image uploads to manage. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  // Deterministic hue per person, so faces stay recognisable across screens.
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        size === 'sm' ? 'h-6 w-6 text-2xs' : 'h-8 w-8 text-xs',
      )}
      style={{ backgroundColor: `hsl(${hue} 45% 45%)` }}
      title={name}
    >
      {initials}
    </span>
  );
}

export { clsx };
