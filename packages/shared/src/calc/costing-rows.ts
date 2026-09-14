/**
 * The arithmetic of one costing row, in whichever direction it is given.
 *
 * A row is three numbers with one relationship: `cost = consumption × unit
 * price`. Which two a person has depends on what they are holding. Off a
 * supplier invoice they have the consumption and the total; off a price list
 * they have the rate; from the warehouse they have the quantity issued. Making
 * them reach for a calculator to supply the third is the thing this exists to
 * stop.
 *
 * So any one of the three can be typed and the others follow. What must not
 * happen is a silent overwrite of something the person entered, so the row
 * remembers which single field it worked out for them — that one, and only
 * that one, is recomputed when its neighbours change.
 */

export type RowField = 'quantity' | 'unitPrice' | 'cost';

export interface RowState {
  quantity: number | null;
  unitPriceUsd: number | null;
  /** Which field the system filled in. Null when nothing has been derived. */
  derivedField: RowField | null;
}

/** `cost = consumption × unit price`, or nothing when either is unknown. */
export function rowCost(row: Pick<RowState, 'quantity' | 'unitPriceUsd'>): number | null {
  const { quantity, unitPriceUsd } = row;
  if (quantity == null || unitPriceUsd == null) return null;
  const cost = quantity * unitPriceUsd;
  return Number.isFinite(cost) ? cost : null;
}

/** Usable as a divisor: present, finite and not zero. */
function divisible(v: number | null): v is number {
  return v != null && Number.isFinite(v) && v !== 0;
}

/**
 * Apply one edit and work out whatever else the row now supports.
 *
 * Editing consumption or unit price recomputes the cost, which is the ordinary
 * direction. Editing the cost works backwards: against a known consumption it
 * gives the unit price, against a known unit price it gives the consumption,
 * and against neither it is recorded as a single lot at that price — which is
 * how a freight charge or a one-off fee belongs on a costing anyway.
 *
 * Clearing a field clears what was derived from it rather than leaving a
 * number whose inputs have gone.
 */
export function applyRowEdit(row: RowState, field: RowField, value: number | null): RowState {
  if (field === 'quantity') {
    if (value == null) {
      // Losing the consumption invalidates anything worked out from it.
      return { ...row, quantity: null, ...(row.derivedField === 'unitPrice' ? { unitPriceUsd: null } : {}) };
    }
    if (row.unitPriceUsd != null && row.derivedField !== 'unitPrice') {
      return { ...row, quantity: value, derivedField: 'cost' };
    }
    if (row.derivedField === 'unitPrice' && divisible(value)) {
      // The cost was the person's figure: hold it and re-rate.
      const held = rowCost(row);
      if (held != null) return { quantity: value, unitPriceUsd: held / value, derivedField: 'unitPrice' };
    }
    return { ...row, quantity: value, derivedField: row.unitPriceUsd == null ? row.derivedField : 'cost' };
  }

  if (field === 'unitPrice') {
    if (value == null) {
      return { ...row, unitPriceUsd: null, ...(row.derivedField === 'quantity' ? { quantity: null } : {}) };
    }
    if (row.derivedField === 'quantity' && divisible(value)) {
      const held = rowCost(row);
      if (held != null) return { quantity: held / value, unitPriceUsd: value, derivedField: 'quantity' };
    }
    return { ...row, unitPriceUsd: value, derivedField: row.quantity == null ? row.derivedField : 'cost' };
  }

  // field === 'cost'
  if (value == null) {
    // The cost is never stored in its own right, so clearing it clears
    // whichever half of the multiplication the system had supplied.
    if (row.derivedField === 'unitPrice') return { ...row, unitPriceUsd: null, derivedField: null };
    if (row.derivedField === 'quantity') return { ...row, quantity: null, derivedField: null };
    return { ...row, unitPriceUsd: null, derivedField: null };
  }
  if (divisible(row.quantity) && row.derivedField !== 'quantity') {
    return { ...row, unitPriceUsd: value / row.quantity, derivedField: 'unitPrice' };
  }
  if (divisible(row.unitPriceUsd) && row.derivedField !== 'unitPrice') {
    return { ...row, quantity: value / row.unitPriceUsd, derivedField: 'quantity' };
  }
  // Neither is known: one lot at that price, which is what a freight charge is.
  return { quantity: 1, unitPriceUsd: value, derivedField: 'unitPrice' };
}
