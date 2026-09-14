/**
 * How an Actual Costing field reads, and what it accepts while being typed.
 *
 * Both rules exist because of the same mistake. The fields first showed their
 * value as an input *placeholder* when nothing had been typed, which renders
 * grey and reads as disabled: the screen looked inert even though every field
 * took input. A resting field must show its figure as real text, and a figure
 * nobody has supplied must say so rather than sit blank.
 */

import { fmtMoney, fmtNumber, fmtPct } from './num.js';

export type CellKind = 'money' | 'percent' | 'number' | 'text';

/** A costing figure as it reads when nobody is typing into it. */
export function formatCell(
  value: number | string | null | undefined,
  kind: CellKind,
  places?: number,
): string {
  if (kind === 'text') return typeof value === 'string' && value !== '' ? value : '—';
  const n = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (kind === 'money') return fmtMoney(n, '$', places ?? 2);
  if (kind === 'percent') return fmtPct(n, places ?? 1);
  return fmtNumber(n, { places: places ?? 0 });
}

/**
 * Whether a numeric field should accept this keystroke.
 *
 * Deliberately permissive about half-finished numbers: refusing "1." or a lone
 * "-" would make 1.5 and negative figures impossible to type at all.
 */
export function isTypeableNumber(text: string): boolean {
  return text === '' || /^-?\d*\.?\d*$/.test(text);
}
