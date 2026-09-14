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
  /**
   * What the warehouse actually issued. Null until something has been, because
   * an actual costing may not report a plan as a fact — the estimate is carried
   * separately and shown beside the field, for a person to measure against.
   */
  issuedQty: number | null;
  /** What the bill of materials planned. Reference only; never costed. */
  requiredQty: number | null;
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
  /** What was planned, for the screen to show beside the actual. Not costed. */
  estimatedQty?: number | null;
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

  // ── Materials, one row each ─────────────────────────────────────────────
  //
  // The costing sheet lists materials individually — item, actual consumption,
  // unit, unit price, cost — under UsedFabric and UsedAcc, and prints the
  // section subtotal beneath. Collapsing a category into a single lump would
  // lose the consumption and the unit price, which are three of the sheet's
  // six columns, so each BOM row becomes a line of its own.
  //
  // A row with no price still appears, with its cost blank. That is what the
  // sheet does, and it is how a coordinator sees which material is still
  // waiting on a price rather than wondering why the fabric total looks light.
  const bom = [...input.bom].sort((a, b) =>
    a.category === b.category ? a.item.localeCompare(b.item) : a.category.localeCompare(b.category),
  );

  for (const b of bom) {
    lines.push({
      group: bomGroupFor(b.category),
      label: b.item,
      // Only what was genuinely issued. A row with nothing issued arrives
      // blank, with its planned figure alongside, and waits for the person who
      // measured it — which is the difference between an actual costing and a
      // second copy of the plan.
      quantity: b.issuedQty != null && b.issuedQty > 0 ? b.issuedQty : null,
      unit: b.unit,
      unitPriceUsd: b.unitPriceUsd,
      estimatedQty: b.requiredQty,
      sourceRef: `bom:${b.category}`,
    });
  }

  // ── Outside work, one row per operation ─────────────────────────────────
  //
  // Grouped by operation rather than listed per row: the sheet has a line for
  // sublimation and a line for embroidery, not one per consignment sent out.
  const byOp = new Map<string, DerivableExternalOp[]>();
  for (const e of input.external) {
    const list = byOp.get(e.operationType) ?? [];
    list.push(e);
    byOp.set(e.operationType, list);
  }

  for (const [op, ops] of [...byOp].sort(([a], [b]) => a.localeCompare(b))) {
    const priced = ops.filter((o) => o.qty != null && o.unitPriceUsd != null);
    // A partial sum reads as a complete one, so a mixed group says nothing.
    if (priced.length === 0 || priced.length !== ops.length) {
      lines.push({
        group: 'EXTERNAL', label: humanise(op),
        quantity: sumOrNull(ops.map((o) => o.qty)), unit: 'PCS',
        unitPriceUsd: null, sourceRef: `external:${op}`,
      });
      continue;
    }

    const qty = sum(priced.map((o) => o.qty!));
    const cost = sum(priced.map((o) => o.qty! * o.unitPriceUsd!));
    lines.push({
      group: 'EXTERNAL',
      label: humanise(op),
      quantity: qty,
      unit: 'PCS',
      // The blended rate across consignments, so quantity × price is the cost
      // even when two batches went out at different prices.
      unitPriceUsd: qty > 0 ? cost / qty : null,
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

/** Sum that stays null when nothing was recorded at all. */
function sumOrNull(values: readonly (number | null)[]): number | null {
  return values.every((v) => v == null) ? null : sum(values);
}

/** `POLY_BAG` → `Poly bag`. The sheet's vocabulary, not the database's. */
function humanise(token: string): string {
  const spaced = token.replace(/[_-]+/g, ' ').toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
