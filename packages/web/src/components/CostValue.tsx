/**
 * An Actual Costing value: shown, and editable in place.
 *
 * Every figure on that screen can be written by hand, the calculated ones
 * included — a coordinator reconciling against an invoice has to be able to put
 * the invoice's number in the field, and one that refuses is one they keep a
 * spreadsheet beside.
 *
 * Typing here never rewrites the facts underneath. The ledgers, the bill of
 * materials and the order stay as production recorded them; the typed figure is
 * stored beside them. So a field showing 1,500 where the application worked out
 * 2,000 says so, keeps the calculated figure in reach, and has a revert control
 * that puts it straight back. A number nobody can explain or undo is worse than
 * one that cannot be edited.
 *
 * The input is text rather than `number` so a resting field can read "$1,260.00"
 * — a number input cannot show a formatted value. It turns back into a plain
 * editable figure the moment it is focused, because formatting something
 * somebody is halfway through typing is how "1,2" becomes unparseable.
 */

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { formatCell, isTypeableNumber, NOT_CALCULATED, type CellKind } from '@opsflow/shared';
import { clsx } from './ui';

/**
 * What a field holds once it is focused: the typed figure if there is one, else
 * the calculated one as a plain number, so editing starts from what is on
 * screen rather than from an empty box.
 */
function rawOf(override: string, calculated: number | string | null): string {
  if (override.trim() !== '') return override;
  return calculated == null ? '' : String(calculated);
}

export function CostValue({
  value, calculated, kind, places, onChange, onRevert, editable,
  align = 'right', placeholder, className, id,
}: {
  /** What the coordinator has typed, as raw text. Empty means not overridden. */
  value: string;
  /** What the application worked out, or read from the order. */
  calculated: number | string | null;
  kind: CellKind;
  places?: number;
  onChange: (next: string) => void;
  onRevert: () => void;
  editable: boolean;
  align?: 'right' | 'left';
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const [focused, setFocused] = useState(false);
  const overridden = value.trim() !== '';

  const shown = overridden
    ? formatCell(kind === 'text' ? value : Number(value), kind, places)
    : formatCell(calculated, kind, places);

  if (!editable) {
    return (
      <p className={clsx(
        'rounded-md border border-ink-200 bg-ink-50 px-2.5 py-1.5 text-sm text-ink-800',
        align === 'right' && 'tnum text-right',
        className,
      )}>
        {shown}
      </p>
    );
  }

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        inputMode={kind === 'text' ? 'text' : 'decimal'}
        className={clsx(
          'input',
          align === 'right' && 'tnum text-right',
          overridden && 'border-violet-400 bg-violet-50 pr-7 font-medium text-violet-900',
          className,
        )}
        value={focused ? rawOf(value, calculated) : shown === NOT_CALCULATED ? '' : shown}
        placeholder={placeholder ?? (shown === NOT_CALCULATED ? NOT_CALCULATED : '')}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const next = e.target.value;
          if (kind !== 'text' && !isTypeableNumber(next)) return;
          onChange(next);
        }}
      />
      {overridden && (
        <button
          type="button"
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-violet-600
                     hover:bg-violet-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
          title={`Put back the calculated figure — ${formatCell(calculated, kind, places)}`}
          aria-label={`Revert to the calculated figure, ${formatCell(calculated, kind, places)}`}
          onClick={onRevert}
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
