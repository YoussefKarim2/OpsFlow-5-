/**
 * One Actual Costing figure, in the shape every other OpsFlow field uses:
 * a label, the value as plain text, and an input only once the screen is in
 * edit mode.
 *
 * Every figure here can be written by hand, the calculated ones included — a
 * coordinator reconciling against an invoice has to be able to put the
 * invoice's number in the field. Typing never rewrites the facts underneath:
 * the ledgers, the bill of materials and the order stay as production recorded
 * them, and the typed figure is stored beside them. A field showing 1,500 where
 * the application worked out 2,000 says so and offers the calculated figure
 * back, because a number nobody can explain or undo is worse than one that
 * cannot be edited.
 *
 * The input is text rather than `number` so a resting field can read
 * "$1,260.00" — a number input cannot display a formatted value — and it holds
 * the plain figure while being typed into.
 */

import { useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { fitWidth } from '../lib/fit-width';
import { editableText, fmtMoney, formatCell, isTypeableNumber, NOT_CALCULATED, type CellKind } from '@opsflow/shared';
import { clsx } from './ui';

/**
 * One row of a figures sheet: the name on the left with a note under it —
 * where the figure came from, how it was worked out, or what it is still
 * waiting for — and the figure on the right. Every figure on the costing
 * has this shape, whether it was typed, read or worked out, so the page
 * reads as one document rather than three kinds of form.
 */
export function SheetRow({ label, note, noteTone = 'muted', children }: {
  label: string;
  note?: ReactNode;
  noteTone?: 'muted' | 'amber' | 'violet' | 'red';
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink-700">{label}</p>
        {note && (
          <p className={clsx(
            'text-2xs leading-snug',
            noteTone === 'muted' && 'text-ink-400',
            noteTone === 'amber' && 'text-amber-700',
            noteTone === 'violet' && 'text-violet-600',
            noteTone === 'red' && 'text-red-700',
          )}>
            {note}
          </p>
        )}
      </div>
      <div className="shrink-0 text-right">{children}</div>
    </div>
  );
}

export function CostField({
  label, editing, value, calculated, kind, places, onChange, onRevert, hint, from, waiting,
}: {
  label: string;
  editing: boolean;
  /** What the coordinator has typed, as raw text. Empty means not overridden. */
  value: string;
  /** What the application worked out, or read from the order. */
  calculated: number | string | null;
  kind: CellKind;
  places?: number;
  onChange: (next: string) => void;
  onRevert: () => void;
  hint?: string;
  /** Where the calculated figure comes from, named under the label. */
  from?: string;
  /**
   * What this figure is missing, when it could not be worked out. The engine
   * names it, because it is the only thing that knows which input was absent —
   * "Waiting for the shipped quantity" is something a person can act on.
   */
  waiting?: string;
}) {
  const [focused, setFocused] = useState(false);
  const overridden = value.trim() !== '';
  const unknown = !overridden && calculated == null;
  const shown = overridden
    ? formatCell(kind === 'text' ? value : Number(value), kind, places)
    : formatCell(calculated, kind, places);
  const calcText = formatCell(calculated, kind, places);

  // One note under the label, the most useful one: that the figure was typed,
  // else what it waits for, else where it came from or how it was worked out.
  const [note, noteTone] = overridden
    ? [`typed · calculated ${calcText}`, 'violet' as const]
    : unknown && waiting ? [waiting, 'amber' as const]
    : from ? [`from ${from}`, 'muted' as const]
    : [hint, 'muted' as const];

  return (
    <SheetRow label={label} note={note} noteTone={noteTone}>
      {editing ? (
        <div className="relative">
          <input
            type="text"
            inputMode={kind === 'text' ? 'text' : 'decimal'}
            className={clsx('input', kind === 'text' ? 'w-52' : 'tnum w-36 text-right',
              // A worked-out field is still typeable, but it should not look
              // like a blank waiting to be filled in.
              !overridden && 'border-dashed border-ink-200 bg-ink-50/60',
              overridden && 'border-violet-400 bg-violet-50 pr-8 text-violet-900')}
            // Backspaced to empty, the box stays empty while it has the
            // cursor: the calculated figure filling it at once meant the next
            // digit typed went on the end of it (12.35 → 12.358).
            value={value !== '' ? value : focused ? '' : editableText(calculated, kind, places)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            // What it waits for is written under the label; inside the box,
            // cut to "Waiting for the shipped qu", it said nothing.
            placeholder={unknown ? NOT_CALCULATED : ''}
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
              title={`Put back the calculated figure — ${calcText}`}
              aria-label={`Revert to the calculated figure, ${calcText}`}
              onClick={onRevert}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
      ) : (
        <p
          className={clsx(
            'text-sm font-semibold', kind !== 'text' && 'tnum',
            overridden ? 'text-violet-800' : unknown ? 'text-ink-300' : 'text-ink-900',
          )}
          title={unknown ? NOT_CALCULATED : shown}
        >
          {unknown ? '—' : shown}
        </p>
      )}
    </SheetRow>
  );
}

/** A figure stored in its own column rather than typed over a calculation. */
export function StoredField({
  label, editing, value, onChange, hint, invalid, type = 'decimal', kind = 'number', fallback,
}: {
  label: string;
  editing: boolean;
  value: string;
  onChange: (v: string) => void;
  /** What the figure is, in a few words. Shown under the label in both modes. */
  hint?: string;
  /** Why what was typed cannot be stored, when it cannot. */
  invalid?: string;
  type?: 'decimal' | 'date';
  /** How a stored figure reads at rest: "$38.49" rather than "38.49". */
  kind?: 'money' | 'number';
  /** The figure OpsFlow uses while the box is blank, and where it holds it. */
  fallback?: { value: string; note: string };
}) {
  const blank = value.trim() === '';
  const display = blank
    ? (fallback?.value ?? '—')
    : kind === 'money' && Number.isFinite(Number(value)) ? fmtMoney(Number(value)) : value;
  const [note, noteTone] = invalid
    ? [invalid, 'red' as const]
    : blank && fallback
      ? [editing ? `blank — ${fallback.value}, ${fallback.note}, is used` : fallback.note, 'muted' as const]
      : [hint, 'muted' as const];

  return (
    <SheetRow label={label} note={note} noteTone={noteTone}>
      {editing ? (
        type === 'date' ? (
          <input
            type="date" className="input w-40" value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            type="text" inputMode="decimal"
            className={clsx('input tnum w-36 text-right', invalid && 'border-red-400 ring-1 ring-red-400')}
            value={value}
            placeholder={fallback?.value}
            aria-invalid={invalid ? true : undefined}
            onChange={(e) => { if (isTypeableNumber(e.target.value)) onChange(e.target.value); }}
          />
        )
      ) : (
        <p className={clsx(
          'tnum text-sm font-semibold',
          blank && !fallback ? 'text-ink-300' : blank ? 'text-ink-700' : 'text-ink-900',
        )}>
          {display}
        </p>
      )}
    </SheetRow>
  );
}

/**
 * The same thing inside a table cell, where the column heading is the label.
 * Reads as text until the screen is in edit mode, like every other table in
 * OpsFlow.
 */
export function CostCell({
  editing, value, calculated, kind, places, onChange, onRevert, className,
}: {
  editing: boolean;
  value: string;
  calculated: number | string | null;
  kind: CellKind;
  places?: number;
  onChange: (next: string) => void;
  onRevert: () => void;
  className?: string;
}) {
  const [focused, setFocused] = useState(false);
  const overridden = value.trim() !== '';
  const shown = overridden
    ? formatCell(kind === 'text' ? value : Number(value), kind, places)
    : formatCell(calculated, kind, places);

  if (!editing) {
    return (
      <span
        className={clsx('tnum', overridden ? 'font-medium text-violet-800' : 'text-ink-800', className)}
        title={overridden ? `Typed — calculated ${formatCell(calculated, kind, places)}` : undefined}
      >
        {shown}
      </span>
    );
  }

  return (
    <div className="relative">
      <input
        type="text"
        inputMode="decimal"
        className={clsx('input tnum px-1.5 py-1 text-right text-xs',
          // Room for the revert arrow only when there is one to make room for.
          overridden && 'border-violet-400 bg-violet-50 pr-6 text-violet-900', className)}
        value={value !== '' ? value : focused ? '' : editableText(calculated, kind, places)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={fitWidth(value !== '' ? value : editableText(calculated, kind, places), 6, overridden ? '2.75rem' : '1rem')}
        // A dash, with the words on hover: "Not calculated" does not fit a figure's box.
        placeholder={shown === NOT_CALCULATED ? '—' : ''}
        title={shown === NOT_CALCULATED ? NOT_CALCULATED : undefined}
        onChange={(e) => { if (isTypeableNumber(e.target.value)) onChange(e.target.value); }}
      />
      {overridden && (
        <button
          type="button"
          className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded p-1 text-violet-600 hover:bg-violet-100"
          title={`Put back the calculated figure — ${formatCell(calculated, kind, places)}`}
          aria-label="Revert to the calculated figure"
          onClick={onRevert}
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** A plain text field inside a table cell. */
export function TextCell({
  editing, value, onChange, placeholder, align = 'left',
}: {
  editing: boolean; value: string; onChange: (v: string) => void;
  placeholder?: string; align?: 'left' | 'center' | 'right';
}) {
  if (!editing) {
    return (
      <span className={clsx('text-ink-800', align === 'center' && 'block text-center')}>
        {value || '—'}
      </span>
    );
  }
  return (
    <input
      className={clsx('input px-1.5 py-1 text-xs', align === 'center' && 'text-center')}
      style={fitWidth(value || placeholder || '', 3)}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * A numeric field inside a table cell.
 *
 * `derived` marks the one of consumption / unit price / cost that the system
 * worked out from the other two. It stays editable — typing in it makes it the
 * person's figure and hands the derivation to one of its neighbours — but it
 * is shown differently, so nobody has to wonder which number was theirs.
 */
export function NumberCell({
  editing, value, onChange, placeholder, display, derived,
}: {
  editing: boolean; value: string; onChange: (v: string) => void;
  placeholder?: string; display?: string; derived?: boolean;
}) {
  if (!editing) {
    return (
      <span
        className={clsx('tnum', derived ? 'text-ink-500' : 'text-ink-800')}
        title={derived ? 'Calculated from the other two figures on this row' : undefined}
      >
        {display ?? (value === '' ? '—' : value)}
      </span>
    );
  }
  return (
    <input
      className={clsx('input tnum px-1.5 py-1 text-right text-xs',
        derived && 'border-dashed bg-ink-50 text-ink-600')}
      type="text"
      inputMode="decimal"
      // A figure the row worked out is shown to two decimals, like everything
      // else on the sheet; a figure the person typed is shown as they typed it.
      value={derived && value !== '' ? editableText(value, 'number', 2) : value}
      style={fitWidth(derived && value !== '' ? editableText(value, 'number', 2) : value || placeholder || '')}
      placeholder={placeholder}
      title={derived ? 'Calculated from the other two figures on this row — type here to set it yourself' : undefined}
      onChange={(e) => { if (isTypeableNumber(e.target.value)) onChange(e.target.value); }}
    />
  );
}
