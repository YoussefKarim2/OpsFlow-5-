/**
 * Small inventory display pieces, shared by the materials list, the material
 * detail page and the order's materials tab — so a stock status looks the same
 * wherever it appears. §23's "consistent statuses", made structural rather than
 * a matter of remembering.
 */

import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import {
  STOCK_STATUS_STYLE, MOVEMENT_TYPE_LABEL, fmtNumber,
  type StockPosition, type StockStatus, type MovementType,
} from '@opsflow/shared';
import { clsx } from '../../components/ui';

const TONE_CLASS: Record<'red' | 'amber' | 'green' | 'slate', string> = {
  red: 'bg-red-50 text-red-700 ring-red-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  slate: 'bg-ink-100 text-ink-600 ring-ink-200',
};

/** Status as a word plus a colour — never colour alone (§23). */
export function StockStatusChip({ status }: { status: StockStatus }) {
  const style = STOCK_STATUS_STYLE[status];
  return <span className={clsx('chip', TONE_CLASS[style.tone])}>{style.label}</span>;
}

/**
 * Available stock against the reorder line.
 *
 * The bar measures *available*, not physical, because a shelf full of fabric
 * that is entirely reserved is not stock anyone can use. The reserved portion
 * is shown behind it so the difference is visible rather than merely stated.
 */
export function StockBar({ position }: { position: StockPosition }) {
  const total = Math.max(position.physicalQty, position.reservedQty, 1);
  const availablePct = Math.max(0, Math.min(100, (position.availableQty / total) * 100));
  const reservedPct = Math.max(0, Math.min(100 - availablePct, (position.reservedQty / total) * 100));
  const minimumPct =
    position.minimumQty == null ? null : Math.max(0, Math.min(100, (position.minimumQty / total) * 100));

  const tone = STOCK_STATUS_STYLE[position.status].tone;
  const barColour =
    tone === 'red' ? 'bg-red-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div
      className="relative h-2 w-full overflow-hidden rounded-full bg-ink-100"
      title={
        `Available ${fmtNumber(position.availableQty, { places: 0 })} · ` +
        `Reserved ${fmtNumber(position.reservedQty, { places: 0 })}` +
        (position.minimumQty == null ? '' : ` · Minimum ${fmtNumber(position.minimumQty, { places: 0 })}`)
      }
    >
      <div className={clsx('absolute inset-y-0 left-0', barColour)} style={{ width: `${availablePct}%` }} />
      <div
        className="absolute inset-y-0 bg-ink-300"
        style={{ left: `${availablePct}%`, width: `${reservedPct}%` }}
      />
      {minimumPct != null && (
        // The reorder line, drawn where it actually falls.
        <div className="absolute inset-y-0 w-px bg-ink-700/60" style={{ left: `${minimumPct}%` }} />
      )}
    </div>
  );
}

/** The four states, spelled out. Used on the material page and the order tab. */
export function StockPositionPanel({
  position, unit, compact,
}: {
  position: StockPosition;
  unit: string;
  compact?: boolean;
}) {
  const cells: Array<{ label: string; value: number; hint?: string; tone?: string }> = [
    { label: 'Physical', value: position.physicalQty, hint: 'On the shelf' },
    { label: 'Reserved', value: position.reservedQty, hint: 'Promised to orders' },
    {
      label: 'Available', value: position.availableQty, hint: 'Free to commit',
      tone: position.availableQty < 0 ? 'text-red-600' : 'text-ink-900',
    },
    { label: 'Consumed', value: position.consumedQty, hint: 'Issued to production' },
  ];

  return (
    <div className={clsx('grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4')}>
      {cells.map((c) => (
        <div key={c.label}>
          <p className="label">{c.label}</p>
          <p className={clsx('tnum text-lg font-semibold', c.tone ?? 'text-ink-900')}>
            {fmtNumber(c.value, { places: 0 })}
            <span className="ml-1 text-xs font-normal text-ink-400">{unit}</span>
          </p>
          {!compact && c.hint && <p className="text-2xs text-ink-400">{c.hint}</p>}
        </div>
      ))}
    </div>
  );
}

/** A movement's direction, as an arrow and a sign rather than colour alone. */
export function MovementDirection({ type, signedQty, unit }: { type: string; signedQty: number; unit: string }) {
  const inbound = signedQty > 0;
  const zero = signedQty === 0;
  const Icon = zero ? Minus : inbound ? ArrowUp : ArrowDown;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 tnum font-medium',
        zero ? 'text-ink-400' : inbound ? 'text-emerald-700' : 'text-red-600',
      )}
      title={MOVEMENT_TYPE_LABEL[type as MovementType] ?? type}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {signedQty > 0 ? '+' : ''}{fmtNumber(signedQty, { places: 0 })}
      <span className="text-2xs font-normal text-ink-400">{unit}</span>
    </span>
  );
}
