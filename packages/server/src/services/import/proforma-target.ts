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

import { ImportConcept, type ImportIssue } from '@opsflow/shared';
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

  const currency = str(f[ImportConcept.CURRENCY])?.toUpperCase().slice(0, 3) ?? 'USD';
  const unitPrice = num(f[ImportConcept.UNIT_PRICE]);

  const style = str(f[ImportConcept.STYLE]) ?? str(f[ImportConcept.ORDER_NAME]);

  // The ORDER matrix is what the customer is being invoiced for; a CUT or
  // PACKED grid describes the factory's own progress and is not billable.
  const lines: ProformaDraftLine[] = [];
  for (const matrix of extraction.matrices ?? []) {
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
  } else if (unitPrice == null) {
    issues.push({
      level: 'WARNING', field: 'unitPrice', sheet: null, cell: null,
      message:
        `${lines.length} item${lines.length === 1 ? '' : 's'} were read but no unit price was found. ` +
        'Enter the prices before sending the invoice.',
    });
  } else {
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
    lines.length > 0 && unitPrice != null ? 'MEDIUM' : 'LOW';

  for (const issue of extraction.issues ?? []) issues.push(issue);

  return {
    number: str(f[ImportConcept.PO_NUMBER]),
    date: str(f[ImportConcept.ORDER_DATE]),
    consignee: str(f[ImportConcept.CLIENT]),
    billingAddress: null,
    email: null,
    shipmentTo: str(f[ImportConcept.DESTINATION]),
    currency,
    terms: null,
    lines,
    confidence,
    issues,
  };
}
