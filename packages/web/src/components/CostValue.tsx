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

import { RotateCcw } from 'lucide-react';
import { formatCell, isTypeableNumber, NOT_CALCULATED, type CellKind } from '@opsflow/shared';
import { clsx } from './ui';

export function CostField({
  label, editing, value, calculated, kind, places, onChange, onRevert, hint, from,
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
}) {
  const overridden = value.trim() !== '';
  const shown = overridden
    ? formatCell(kind === 'text' ? value : Number(value), kind, places)
    : formatCell(calculated, kind, places);

  return (
    <div>
      <p className="label flex items-baseline justify-between gap-2">
        <span>{label}</span>
        {from && <span className="text-2xs font-normal normal-case text-ink-400">from {from}</span>}
      </p>

      {editing ? (
        <>
          <div className="relative">
            <input
              type="text"
              inputMode={kind === 'text' ? 'text' : 'decimal'}
              className={clsx('input', kind !== 'text' && 'tnum text-right',
                overridden && 'border-violet-400 bg-violet-50 pr-8 text-violet-900')}
              value={value !== '' ? value : calculated == null ? '' : String(calculated)}
              placeholder={shown === NOT_CALCULATED ? NOT_CALCULATED : ''}
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
          {hint && <p className="mt-1 text-2xs text-ink-500">{hint}</p>}
        </>
      ) : (
        <>
          <p className={clsx('text-sm', overridden ? 'font-medium text-violet-800' : 'text-ink-800')}>
            {shown}
          </p>
          {overridden && (
            <p className="mt-0.5 text-2xs text-violet-600">
              typed — calculated {formatCell(calculated, kind, places)}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A figure stored in its own column rather than typed over a calculation. */
export function StoredField({
  label, editing, value, onChange, hint, type = 'decimal',
}: {
  label: string;
  editing: boolean;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  type?: 'decimal' | 'date';
}) {
  return (
    <div>
      <p className="label">{label}</p>
      {editing ? (
        <>
          {type === 'date' ? (
            <input
              type="date" className="input" value={value}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <input
              type="text" inputMode="decimal" className="input tnum text-right" value={value}
              onChange={(e) => { if (isTypeableNumber(e.target.value)) onChange(e.target.value); }}
            />
          )}
          {hint && <p className="mt-1 text-2xs text-ink-500">{hint}</p>}
        </>
      ) : (
        <p className="text-sm text-ink-800">{value === '' ? '—' : value}</p>
      )}
    </div>
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
        className={clsx('input tnum py-1 text-right text-xs',
          overridden && 'border-violet-400 bg-violet-50 pr-7 text-violet-900', className)}
        value={value !== '' ? value : calculated == null ? '' : String(calculated)}
        placeholder={shown === NOT_CALCULATED ? NOT_CALCULATED : ''}
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
      className={clsx('input py-1 text-xs', align === 'center' && 'text-center')}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** A numeric field inside a table cell, stored in its own column. */
export function NumberCell({
  editing, value, onChange, placeholder, display,
}: {
  editing: boolean; value: string; onChange: (v: string) => void;
  placeholder?: string; display?: string;
}) {
  if (!editing) {
    return <span className="tnum text-ink-800">{display ?? (value === '' ? '—' : value)}</span>;
  }
  return (
    <input
      className="input tnum py-1 text-right text-xs"
      type="text"
      inputMode="decimal"
      value={value}
      placeholder={placeholder}
      onChange={(e) => { if (isTypeableNumber(e.target.value)) onChange(e.target.value); }}
    />
  );
}
