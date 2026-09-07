/**
 * Where an actual cost came from.
 *
 * `computeCosting` next door turns cost lines into totals. This module answers
 * the earlier question — what the lines should be — by reading the production
 * sections that already hold the numbers, so that "actual costing" means the
 * cost of what actually happened rather than a second set of figures somebody
 * retyped from the same sheets.
 *
 * Two rules shape all of it.
 *
 * **Only what is known.** A derivation with a missing price or a missing
 * quantity produces no line at all, not a zero. A zero is a claim that
 * something was free; silence is a claim that nobody has said yet, and the
 * screen renders those differently. Every division goes through `safeDiv`.
 *
 * **Traceable.** Every derived line carries a `sourceRef` naming the section and
 * the grouping it came from — `bom:FABRIC`, `external:PRINTING` — so a number
 * on the costing screen can be followed back to the row that produced it, and a
 * figure nobody can explain does not appear.
 *
 * Nothing here reads a database or writes anything. It takes the production
 * facts and returns proposed lines, which is what makes it testable by value.
 */

import { sum } from './num.js';
// The same five groups `computeCosting` reports against. Imported rather than
// redeclared so a group added there cannot be forgotten here.
import type { CostGroup } from './costing.js';

/** A BOM row, as far as costing is concerned. */
export interface DerivableBomItem {
  category: string;
  item: string;
  /** What was actually issued where that is known, else what is required. */
  quantity: number | null;
  unit: string;
  unitPriceUsd: number | null;
}

/** One completed piece of outside work. */
export interface DerivableExternalOp {
  operationType: string;
  qty: number | null;
  unitPriceUsd: number | null;
}

export interface DerivableProduction {
  /** Machine-days actually worked, from the production follow-up. */
  machineDaysUsed: number | null;
  /** The factory's daily running cost, in EGP. */
  dailyCostEgp: number | null;
  dollarRate: number | null;
}

export interface DerivableInputs {
  bom: readonly DerivableBomItem[];
  external: readonly DerivableExternalOp[];
  production: DerivableProduction;
}

export interface DerivedLine {
  group: CostGroup;
  label: string;
  quantity: number | null;
  unit: string;
  unitPriceUsd: number | null;
  /** `section:grouping` — what this was computed from. */
  sourceRef: string;
}

/**
 * Which cost group a BOM category belongs to.
 *
 * Fabric is its own group because it is usually the largest single cost and is
 * reported separately; everything else the BOM carries — trims, labels,
 * packaging, badges — is an accessory cost as far as the costing sheet is
 * concerned, which is the distinction the sheet itself draws.
 */
export function bomGroupFor(category: string): CostGroup {
  return category === 'FABRIC' ? 'FABRIC' : 'ACCESSORY';
}

/**
 * Propose the cost lines the production data already supports.
 *
 * Items of the same category are summed into one line rather than listed
 * individually: the costing sheet reports "fabric" as a figure, and forty rows
 * of it would be the bill of materials again rather than a costing. The
 * `sourceRef` says which category, so the detail is still reachable.
 *
 * A category is only summed when *every* contributing row has both a quantity
 * and a price. A partial sum reads as a complete one and is worse than nothing:
 * it would show a fabric cost that is quietly missing two of its five fabrics.
 */
export function deriveCostLines(input: DerivableInputs): DerivedLine[] {
  const lines: DerivedLine[] = [];

  // ── Materials, grouped by BOM category ──────────────────────────────────
  const byCategory = new Map<string, DerivableBomItem[]>();
  for (const b of input.bom) {
    const list = byCategory.get(b.category) ?? [];
    list.push(b);
    byCategory.set(b.category, list);
  }

  for (const [category, items] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
    const priced = items.filter((i) => i.quantity != null && i.unitPriceUsd != null);
    if (priced.length === 0 || priced.length !== items.length) continue;

    const cost = sum(priced.map((i) => i.quantity! * i.unitPriceUsd!));
    if (cost == null) continue;

    lines.push({
      group: bomGroupFor(category),
      label: `${humanise(category)} (${items.length} item${items.length === 1 ? '' : 's'})`,
      // One line, one unit price: the quantity is the money and the unit is a
      // lump, because summing metres and pieces into a single quantity would be
      // arithmetic on incompatible things.
      quantity: 1,
      unit: 'LOT',
      unitPriceUsd: cost,
      sourceRef: `bom:${category}`,
    });
  }

  // ── Outside work, grouped by operation ──────────────────────────────────
  const byOp = new Map<string, DerivableExternalOp[]>();
  for (const e of input.external) {
    const list = byOp.get(e.operationType) ?? [];
    list.push(e);
    byOp.set(e.operationType, list);
  }

  for (const [op, ops] of [...byOp].sort(([a], [b]) => a.localeCompare(b))) {
    const priced = ops.filter((o) => o.qty != null && o.unitPriceUsd != null);
    if (priced.length === 0 || priced.length !== ops.length) continue;

    const cost = sum(priced.map((o) => o.qty! * o.unitPriceUsd!));
    if (cost == null) continue;

    lines.push({
      group: 'EXTERNAL',
      label: humanise(op),
      quantity: 1,
      unit: 'LOT',
      unitPriceUsd: cost,
      sourceRef: `external:${op}`,
    });
  }

  // ── Production labour ───────────────────────────────────────────────────
  //
  // The workbook's own CM formula: machine-days worked × the daily running
  // cost, converted at the recorded dollar rate. Requires all three, and says
  // nothing when any is missing rather than inventing a rate.
  const { machineDaysUsed, dailyCostEgp, dollarRate } = input.production;
  if (machineDaysUsed != null && dailyCostEgp != null && dollarRate != null && dollarRate > 0) {
    lines.push({
      group: 'LABOUR',
      label: 'Production (machine-days × daily cost)',
      quantity: machineDaysUsed,
      unit: 'DAY',
      unitPriceUsd: dailyCostEgp / dollarRate,
      sourceRef: 'production:machine-days',
    });
  }

  return lines;
}

/** `POLY_BAG` → `Poly bag`. The sheet's vocabulary, not the database's. */
function humanise(token: string): string {
  const spaced = token.replace(/[_-]+/g, ' ').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
