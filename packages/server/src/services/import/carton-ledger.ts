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
