/**
 * One cell of the Actual Costing sheet.
 *
 * Every figure on that sheet can be typed over, including the calculated ones.
 * The difficulty is doing that without losing what the application worked out:
 * a cell showing 1,260 with no way to tell whether that came from the bill of
 * materials or from somebody's keyboard is worse than a cell that cannot be
 * edited at all.
 *
 * So a typed cell is marked, holds the calculated figure in its tooltip, and
 * carries a revert control that puts it straight back. Nothing is destroyed by
 * typing here — the ledgers, the bill of materials and the order are untouched,
 * and clearing the cell restores the live number.
 *
 * Numbers read as money, percentages or counts when the cell is at rest, and
 * as a plain editable number the moment it is focused. Formatting a value
 * somebody is halfway through typing is how "1,2" becomes unparseable.
 */

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { fmtMoney, fmtNumber, fmtPct, NOT_CALCULATED } from '@opsflow/shared';
import { clsx } from './ui';

export type CellKind = 'money' | 'percent' | 'number' | 'text';

export function formatCell(
  value: number | string | null | undefined,
  kind: CellKind,
  places?: number,
): string {
  if (kind === 'text') return typeof value === 'string' && value !== '' ? value : '—';
  const n = typeof value === 'number' ? value : null;
  if (kind === 'money') return fmtMoney(n, '$', places ?? 2);
  if (kind === 'percent') return fmtPct(n, places ?? 1);
  return fmtNumber(n, { places: places ?? 0 });
}

export function SheetCell({
  value, calculated, kind, places, onChange, onRevert, editable,
  className, align = 'right', placeholder, title, label, colSpan,
}: {
  /** What the coordinator has typed, as raw text. Empty means not overridden. */
  value: string;
  /** What the sheet says when nothing is typed. */
  calculated: number | string | null;
  kind: CellKind;
  places?: number;
  onChange: (next: string) => void;
  /** Present when this cell is currently overriding a calculated figure. */
  onRevert?: () => void;
  editable: boolean;
  className?: string;
  align?: 'right' | 'center' | 'left';
  placeholder?: string;
  title?: string;
  /** A caption printed inside the cell, for the sheet's last column where the
   *  label and its value share one box. */
  label?: string;
  colSpan?: number;
}) {
  const [focused, setFocused] = useState(false);
  const overridden = value.trim() !== '';

  const resting = overridden
    ? formatCell(kind === 'text' ? value : Number(value), kind, places)
    : formatCell(calculated, kind, places);

  if (!editable) {
    return (
      <td className={clsx('tnum text-right', className)} title={title} colSpan={colSpan}>
        {label && <span className="float-left font-semibold text-ink-800">{label}</span>}
        {resting}
      </td>
    );
  }

  const revertHint = overridden && onRevert
    ? `Calculated: ${formatCell(calculated, kind, places)}`
    : undefined;

  return (
    <td
      className={clsx('relative p-0', className, overridden && 'ring-1 ring-inset ring-violet-400')}
      title={revertHint ?? title}
      colSpan={colSpan}
    >
      <div className="flex items-center">
        {label && (
          <span className="shrink-0 whitespace-nowrap pl-2 text-2xs font-semibold text-ink-800">
            {label}
          </span>
        )}
        <input
          type={kind === 'text' ? 'text' : 'number'}
          step={kind === 'text' ? undefined : 'any'}
          className={clsx(
            'w-full border-0 bg-transparent px-2 py-1 text-xs text-ink-900',
            'focus:bg-white focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent-500',
            align === 'right' && 'tnum text-right',
            align === 'center' && 'text-center',
            overridden && 'font-semibold text-violet-800',
          )}
          value={focused || kind === 'text' ? value : overridden ? value : ''}
          placeholder={focused ? placeholder ?? '' : resting === NOT_CALCULATED ? NOT_CALCULATED : resting}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value)}
        />
        {overridden && onRevert && (
          <button
            type="button"
            className="mr-1 shrink-0 rounded p-0.5 text-violet-600 hover:bg-violet-100"
            title={`Put back the calculated figure — ${formatCell(calculated, kind, places)}`}
            aria-label="Revert to the calculated figure"
            onClick={onRevert}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        )}
      </div>
    </td>
  );
}
