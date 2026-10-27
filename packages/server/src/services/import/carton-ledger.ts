/**
 * What an edited carton changes in the PACKED ledger.
 *
 * Its own module so the arithmetic can be tested by value. See the tests next
 * door for why the two obvious alternatives — incrementing by the new total, or
 * overwriting the ledger row — are both wrong.
 */

/**
 * The per-size difference between what a carton held and what it now holds.
 *
 * Sizes whose quantity is unchanged are omitted entirely rather than returned
 * as zero, so a caller can apply every entry without checking.
 */
export function ledgerDeltas(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const sizeId of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(sizeId) ?? 0) - (before.get(sizeId) ?? 0);
    if (delta !== 0) deltas.set(sizeId, delta);
  }
  return deltas;
}

/**
 * What a stored carton currently counts on the PACKED ledger, per order size.
 *
 * A mixed carton is counted by its size rows; a carton with no rows yet is
 * still its own single-size quantity, and that is what the ledger reflects.
 * Free-text sizes are not cells in the matrix and so are not counted. Shared by
 * the size editor (the "before" of an edit) and the carton delete (everything
 * the carton gives back).
 */
export function cartonHolding(carton: {
  qty: number;
  orderSizeId: string | null;
  lines: ReadonlyArray<{ orderSizeId: string | null; qty: number }>;
}): Map<string, number> {
  const held = new Map<string, number>();
  for (const l of carton.lines) {
    if (l.orderSizeId) held.set(l.orderSizeId, (held.get(l.orderSizeId) ?? 0) + l.qty);
  }
  if (carton.lines.length === 0 && carton.orderSizeId) {
    held.set(carton.orderSizeId, (held.get(carton.orderSizeId) ?? 0) + carton.qty);
  }
  return held;
}

/**
 * The first carton number that would appear twice on one packing list, or null.
 *
 * Compared trimmed and ignoring case — "ctn-004" and "CTN-004 " are the same
 * label on a box. `existing` is the list's stored numbers; `incoming` what is
 * being added, which must not repeat itself either.
 */
export function repeatedCartonNumber(existing: readonly string[], incoming: readonly string[]): string | null {
  const key = (n: string) => n.trim().toUpperCase();
  const seen = new Set(existing.map(key));
  for (const n of incoming) {
    if (seen.has(key(n))) return n.trim();
    seen.add(key(n));
  }
  return null;
}
