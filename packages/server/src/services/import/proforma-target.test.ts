/**
 * Mapping an extracted document onto a proforma invoice.
 *
 * The extraction itself is tested next door; these work on `ExtractionResult`
 * values directly, which is the point of that shared type — a workbook, a CSV
 * and a PDF are indistinguishable here.
 *
 * The rule worth protecting is that confidence is never HIGH. A proforma is a
 * priced document sent to a customer, and no extraction should be trusted
 * enough to skip somebody reading it.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildProformaDraft } from './proforma-target.js';
import type { ExtractionResult } from './extractor.js';

const base = (over: Partial<ExtractionResult> = {}): ExtractionResult => ({
  profileKey: null, confidence: 0, sheets: [], mappings: [], fields: {},
  matrices: [], lineItems: [], bom: [], lays: [], externalColors: [], costing: {}, issues: [],
  ...over,
});

const matrix = (rows: Array<{ color: string; cells: Record<string, number> }>, sizes: string[]) => ({
  ledger: 'ORDER', sizes,
  rows: rows.map((r) => ({ ...r, total: Object.values(r.cells).reduce((a, b) => a + b, 0) })),
  sheetTotal: null, computedTotal: 0,
});

describe('building a proforma from an extraction', () => {
  test('header fields come across whatever the document was', () => {
    const d = buildProformaDraft(base({
      fields: { PO_NUMBER: 'PI-4471', CLIENT: 'Hummel', CURRENCY: 'eur', DESTINATION: 'Aarhus' },
    }));
    assert.equal(d.number, 'PI-4471');
    assert.equal(d.consignee, 'Hummel');
    assert.equal(d.currency, 'EUR');       // normalised
    assert.equal(d.shipmentTo, 'Aarhus');
  });

  test('a size grid becomes priced invoice lines', () => {
    const d = buildProformaDraft(base({
      fields: { UNIT_PRICE: 5.5, STYLE: 'Florida Tee' },
      matrices: [matrix([{ color: 'Red', cells: { S: 100, M: 150 } }], ['S', 'M'])],
    }));
    assert.equal(d.lines.length, 2);
    assert.equal(d.lines[0]!.description, 'Florida Tee — Red — S');
    assert.equal(d.lines[0]!.quantity, 100);
    assert.equal(d.lines[0]!.unitPrice, 5.5);
  });

  test('empty cells are not invoiced', () => {
    const d = buildProformaDraft(base({
      matrices: [matrix([{ color: 'Red', cells: { S: 0, M: 20 } }], ['S', 'M'])],
    }));
    assert.equal(d.lines.length, 1);
    assert.equal(d.lines[0]!.quantity, 20);
  });

  test('only the ORDER grid is billable', () => {
    // A CUT or PACKED grid is the factory's own progress, not what the customer
    // is being charged for.
    const cut = { ...matrix([{ color: 'Red', cells: { S: 999 } }], ['S']), ledger: 'CUT' };
    assert.equal(buildProformaDraft(base({ matrices: [cut] })).lines.length, 0);
  });

  test('a document with no priced rows says so and still yields a header', () => {
    const d = buildProformaDraft(base({ fields: { CLIENT: 'Hummel' } }));
    assert.equal(d.lines.length, 0);
    assert.equal(d.consignee, 'Hummel');
    assert.ok(d.issues.some((i) => /add the items by hand/i.test(i.message)));
  });

  test('lines without a price are flagged rather than invoiced at zero', () => {
    const d = buildProformaDraft(base({
      matrices: [matrix([{ color: 'Red', cells: { S: 100 } }], ['S'])],
    }));
    assert.equal(d.lines[0]!.unitPrice, null);
    // The message now names how many lines are unpriced, which is what a person
    // needs in order to go and fill them in.
    assert.ok(d.issues.some((i) => /1 without a price/i.test(i.message)));
    assert.equal(d.confidence, 'LOW');
  });

  test('one price applied to every line is stated, not hidden', () => {
    const d = buildProformaDraft(base({
      fields: { UNIT_PRICE: 5.5 },
      matrices: [matrix([{ color: 'Red', cells: { S: 100, M: 50 } }], ['S', 'M'])],
    }));
    assert.ok(d.issues.some((i) => /Every line was priced at 5.5/i.test(i.message)));
  });

  test('confidence is never HIGH, however clean the document', () => {
    const d = buildProformaDraft(base({
      fields: { PO_NUMBER: 'PI-1', CLIENT: 'X', UNIT_PRICE: 2, CURRENCY: 'USD' },
      matrices: [matrix([{ color: 'Red', cells: { S: 10 } }], ['S'])],
    }));
    assert.equal(d.confidence, 'MEDIUM');
  });

  test('extraction issues are carried through, not swallowed', () => {
    const d = buildProformaDraft(base({
      issues: [{ level: 'ERROR', field: null, sheet: null, cell: null, message: 'scanned document' }],
    }));
    assert.ok(d.issues.some((i) => i.message === 'scanned document'));
  });
});

describe('reading a proforma out of a document', () => {
  test('the header is read whichever key convention the reader used', async () => {
    // The readers translate concepts into the order's field names before they
    // return, and this module was still looking up the concept — so a proforma
    // imported with its number, date and consignee blank however plainly the
    // document stated them.
    const draft = buildProformaDraft({
      profileKey: null, confidence: 0, sheets: [], mappings: [],
      fields: { poNumber: 'PI-2026-44', clientName: 'Meyba International', poDate: new Date('2026-05-01') },
      matrices: [], lineItems: [], bom: [], lays: [], externalColors: [], costing: {}, issues: [],
    } as never);
    assert.equal(draft.number, 'PI-2026-44');
    assert.equal(draft.consignee, 'Meyba International');
    assert.equal(draft.date, '2026-05-01', 'a date must be a day, not a JavaScript date string');
  });

  test('the concept keys still work, so neither convention can break it', async () => {
    const draft = buildProformaDraft({
      profileKey: null, confidence: 0, sheets: [], mappings: [],
      fields: { PO_NUMBER: 'PI-7', CLIENT: 'Meyba' },
      matrices: [], lineItems: [], bom: [], lays: [], externalColors: [], costing: {}, issues: [],
    } as never);
    assert.equal(draft.number, 'PI-7');
    assert.equal(draft.consignee, 'Meyba');
  });
});
