/**
 * Typing over a calculated cell.
 *
 * Every figure on the Actual Costing sheet can be written by hand, including
 * the ones the application worked out. A coordinator reconciling against an
 * invoice needs to be able to put the invoice's number in the cell, and a
 * screen that refuses is a screen they keep a spreadsheet beside.
 *
 * What an override is *not* is a silent edit. Typing a total here does not
 * rewrite the bill of materials, the ledgers or the order — the underlying
 * facts stay exactly as production recorded them. The typed value is stored
 * separately, shown as overridden, carries the calculated figure alongside it,
 * and can be cleared to fall straight back to the live number. Without that,
 * a costing nobody can explain is indistinguishable from one that is simply
 * out of date.
 *
 * Overrides cascade the way a spreadsheet does: override the fabric total and
 * the grand total, the unit cost and the profit all move with it.
 */

/** The cells that may be overridden. Anything not on this list is not storable. */
export const OVERRIDE_KEYS = [
  // Identity — free text, display only.
  'customer', 'orderName', 'itemType', 'poNumber', 'styleNumber',
  // Machine economics.
  'machineCostEgpPerDay', 'workDays', 'productivityRate',
  // Production quantities.
  'orderQty', 'cutQty', 'shippedQty', 'firstDegreeQty', 'secondDegreeQty', 'diffPct',
  // The costing table's computed rows.
  'fabricCostUsd', 'accessoryCostUsd', 'cmCostUsd', 'totalCostUsd',
  // Money.
  'sellPriceUsd', 'unitActualCostUsd', 'profitPerUnitUsd', 'profitPct', 'targetPriceUsd',
] as const;

export type OverrideKey = (typeof OVERRIDE_KEYS)[number];

/** The five identity cells hold text; every other override is a number. */
export const TEXT_OVERRIDE_KEYS: readonly OverrideKey[] = [
  'customer', 'orderName', 'itemType', 'poNumber', 'styleNumber',
];

export function isTextOverride(key: OverrideKey): boolean {
  return TEXT_OVERRIDE_KEYS.includes(key);
}

export type CostingOverrides = Partial<Record<OverrideKey, number | string | null>>;

export function isOverrideKey(key: string): key is OverrideKey {
  return (OVERRIDE_KEYS as readonly string[]).includes(key);
}

/**
 * Keep only the keys the sheet knows, drop cleared ones, and reject values
 * that could never render — a stored `NaN` would put an error code on the
 * screen, which is the one thing this sheet promises never to do.
 */
export function sanitiseOverrides(raw: unknown): CostingOverrides {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: CostingOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isOverrideKey(key)) continue;
    if (value == null || value === '') continue;            // cleared
    if (isTextOverride(key)) {
      if (typeof value !== 'string') continue;
      const text = value.trim().slice(0, 200);
      if (text !== '') out[key] = text;
      continue;
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) continue;
    out[key] = n;
  }
  return out;
}

/** The overriding number for a cell, or null when the calculated one stands. */
export function numericOverride(
  overrides: CostingOverrides | undefined, key: OverrideKey,
): number | null {
  const v = overrides?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The overriding text for an identity cell, or null. */
export function textOverride(
  overrides: CostingOverrides | undefined, key: OverrideKey,
): string | null {
  const v = overrides?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}
