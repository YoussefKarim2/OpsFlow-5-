/**
 * Turning an extracted document into a proforma invoice.
 *
 * The extraction is not this module's job and is not repeated here: a workbook,
 * a CSV and a PDF all arrive as the same `ExtractionResult` produced by the
 * readers next door, and this maps that result onto the fields a proforma
 * actually has. One extraction pipeline, several targets — the order importer
 * being the other one — which is why nothing about sheets, glyph positions or
 * synonym scoring appears below.
 *
 * Nothing here writes to the database. It proposes a draft and says how sure it
 * is about each part, and the review screen decides what the user is asked to
 * confirm. A proforma is a priced document sent to a customer; a wrong number
 * on one is worse than a blank.
 */

import { ImportConcept, CONCEPT_META, type ImportIssue } from '@opsflow/shared';
import type { ExtractionResult } from './extractor.js';

export interface ProformaDraftLine {
  description: string;
  quantity: number | null;
  unit: string;
  unitPrice: number | null;
  /** Where the row came from, for the review screen. */
  sourceRow: number | null;
}

export interface ProformaDraft {
  number: string | null;
  date: string | null;
  consignee: string | null;
  billingAddress: string | null;
  email: string | null;
  shipmentTo: string | null;
  currency: string;
  terms: string | null;
  lines: ProformaDraftLine[];
  /** HIGH only when the document said so plainly. */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  issues: ImportIssue[];
}

const str = (v: unknown): string | null => {
  if (v == null) return null;
  // A date reaches here as a Date, and String(date) is
  // "Fri May 01 2026 03:00:00 GMT+0300 (…)" — which is what the invoice showed
  // where it should have said 2026-05-01. The draft's date field is a day, so
  // that is what it gets.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return s === '' ? null : s;
};

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Build a proforma draft from an extraction.
 *
 * Lines come from the quantity matrix when the document carried one, because a
 * colour/size/quantity grid priced per piece *is* a proforma's line list — the
 * same rows the order importer reads, described differently. A document with no
 * matrix yields a header and no lines, which is a perfectly good starting point
 * for somebody who will type them.
 */
export function buildProformaDraft(extraction: ExtractionResult): ProformaDraft {
  const f = extraction.fields ?? {};
  const issues: ImportIssue[] = [];

  /**
   * Read a concept out of the extraction, by either name it might carry.
   *
   * The readers translate concepts into the order's own field names before they
   * return — PO_NUMBER becomes `poNumber` — and this module was still looking
   * up the concept. Every lookup missed, so a proforma imported with its
   * number, date and consignee blank however plainly the document stated them.
   * Both keys are tried so neither convention can break it again.
   */
  const pick = (concept: ImportConcept): string | null => {
    const field = CONCEPT_META[concept]?.field;
    return (field ? str(f[field]) : null) ?? str(f[concept]);
  };
  const pickNum = (concept: ImportConcept): number | null => {
    const field = CONCEPT_META[concept]?.field;
    return (field ? num(f[field]) : null) ?? num(f[concept]);
  };

  const currency = pick(ImportConcept.CURRENCY)?.toUpperCase().slice(0, 3) ?? 'USD';
  const unitPrice = pickNum(ImportConcept.UNIT_PRICE);

  const style = pick(ImportConcept.STYLE) ?? pick(ImportConcept.ORDER_NAME);

  const lines: ProformaDraftLine[] = [];

  /**
   * A proforma written as a list, which is how most of them are written.
   *
   * A description, how many, and what each costs — no colours, no size grid.
   * That shape produced nothing at all until the readers started exposing
   * line-shaped rows, because the only thing this module could build from was a
   * colour × size matrix.
   *
   * Taken first: a document that states its own priced lines has said exactly
   * what it wants invoiced, and rebuilding that from a grid would be guessing
   * at something already written down.
   */
  for (const item of extraction.lineItems ?? []) {
    const description = item.description
      ?? [style, item.unit].filter(Boolean).join(' — ')
      ?? 'Item';
    lines.push({
      description,
      quantity: item.quantity,
      unit: item.unit ?? 'PCS',
      // The row's own price where it has one, the document's single price
      // where it does not.
      unitPrice: item.unitPrice ?? unitPrice,
      sourceRow: item.rowNumber,
    });
  }

  // The ORDER matrix is what the customer is being invoiced for; a CUT or
  // PACKED grid describes the factory's own progress and is not billable.
  // Only consulted when the document did not state its lines outright.
  for (const matrix of lines.length > 0 ? [] : (extraction.matrices ?? [])) {
    if (matrix.ledger && matrix.ledger !== 'ORDER') continue;
    for (const [rowIndex, row] of (matrix.rows ?? []).entries()) {
      for (const size of matrix.sizes ?? []) {
        const qty = num(row.cells?.[size]);
        if (qty == null || qty <= 0) continue;
        lines.push({
          description: [style, row.color, size].filter(Boolean).join(' — ') || 'Item',
          quantity: qty,
          unit: 'PCS',
          // One price for every line unless the document priced them
          // separately. Said out loud below rather than hidden: an invoice
          // where every line silently inherited one price needs checking.
          unitPrice,
          sourceRow: rowIndex,
        });
      }
    }
  }

  if (lines.length === 0) {
    issues.push({
      level: 'WARNING', field: 'lines', sheet: null, cell: null,
      message:
        'No priced rows could be read from this document. The invoice header has been ' +
        'filled in where possible; add the items by hand on the next screen.',
    });
  } else if (lines.some((l) => l.unitPrice == null)) {
    const unpriced = lines.filter((l) => l.unitPrice == null).length;
    issues.push({
      level: 'WARNING', field: 'unitPrice', sheet: null, cell: null,
      message:
        `${lines.length} item${lines.length === 1 ? '' : 's'} were read, ${unpriced} without a price. ` +
        'Enter the missing prices before sending the invoice.',
    });
  } else if (unitPrice != null && lines.every((l) => l.unitPrice === unitPrice)) {
    issues.push({
      level: 'INFO', field: 'unitPrice', sheet: null, cell: null,
      message:
        `Every line was priced at ${unitPrice} ${currency}, the only price found in the document. ` +
        'Change any line that differs.',
    });
  }

  // Deliberately never HIGH. A proforma is a priced document sent to a
  // customer, and no extraction is confident enough to skip a human reading it.
  const confidence: ProformaDraft['confidence'] =
    lines.length > 0 && lines.every((l) => l.unitPrice != null) ? 'MEDIUM' : 'LOW';

  for (const issue of extraction.issues ?? []) issues.push(issue);

  return {
    number: pick(ImportConcept.PO_NUMBER),
    date: pick(ImportConcept.ORDER_DATE) ?? pick(ImportConcept.DELIVERY_DATE),
    consignee: pick(ImportConcept.CLIENT),
    billingAddress: null,
    email: null,
    shipmentTo: pick(ImportConcept.DESTINATION),
    currency,
    terms: null,
    lines,
    confidence,
    issues,
  };
}
