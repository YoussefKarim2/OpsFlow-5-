import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeCosting, type CostingInput } from '@opsflow/shared';
import { renderCostingPdf, type CostingPdfOrder } from './costing-pdf.js';

/**
 * The costing PDF, by value.
 *
 * pdfkit compresses its content streams, so the text cannot be read back
 * from the bytes without a parser; what can be held is that every state of a
 * costing — complete, half-recorded, hand-corrected — renders to a well-formed
 * document, and that the one place the text is stored uncompressed, the
 * document's metadata, names the order.
 */
const order = (costing: Partial<CostingInput> = {}): CostingPdfOrder => ({
  poNumber: '89-39',
  orderName: 'Rosetta tee',
  styleNumber: 'RS-1',
  itemType: 'T-shirt',
  season: 'SS26',
  status: 'SHIPPED',
  client: { id: 'c1', name: 'Kittrich', code: null, shippingAddress: null, billingAddress: null },
  coordinator: null,
  costing: computeCosting({
    orderQty: 1972, cutQty: 2084, shippedQty: 1950,
    dollarRate: 48.5, dailyCostEgp: 1867, machineCount: 38,
    machineDaysUsed: null, daysInLine: 11, lineMachineQty: 12,
    firstDegreeQty: 1950, secondDegreeQty: 24, sellPriceUsd: 7.25,
    customer: 'Kittrich', orderName: 'Rosetta tee', poNumber: '89-39', styleNumber: 'RS-1', itemType: 'T-shirt',
    lines: [
      { group: 'FABRIC', label: 'Rosetta', quantity: 1194, unit: 'met.', unitPriceUsd: 2.1, sourceRef: 'bom:FABRIC:a' },
      { group: 'ACCESSORY', label: 'Poly bag', quantity: 2084, unit: 'Pcs', unitPriceUsd: 0.25 / 48.5, sourceRef: 'bom:PACKAGING:b' },
      { group: 'EXTERNAL', label: 'Sublimation', quantity: 2000, unit: 'PCS', unitPriceUsd: 0.3, sourceRef: 'external:SUBLIMATION' },
      { group: 'EXTERNAL', label: 'Printing', quantity: 2000, unit: 'PCS', unitPriceUsd: 0.1, sourceRef: 'external:PRINTING' },
    ],
    ...costing,
  }),
});

const render = (o: CostingPdfOrder) =>
  renderCostingPdf(o, { generatedBy: 'Ahmed', generatedAt: new Date('2026-10-14T09:30:00Z') });

describe('the costing PDF', () => {
  test('a complete costing renders to a PDF that names the order', async () => {
    const buf = await render(order());
    assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(buf.length > 2000, `only ${buf.length} bytes`);
    const bytes = buf.toString('latin1');
    assert.match(bytes, /Actual Costing . PO 89-39/, 'the title carries the PO');
    assert.match(bytes, /%%EOF\s*$/, 'the document is closed');
  });

  test('a costing with nothing recorded yet still renders', async () => {
    const buf = await render(order({
      shippedQty: null, dollarRate: null, dailyCostEgp: null, machineCount: null,
      daysInLine: null, lineMachineQty: null, firstDegreeQty: null, secondDegreeQty: null,
      sellPriceUsd: null, lines: [],
    }));
    assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  test('typed-over figures and a long note render, across a page break', async () => {
    const buf = await render(order({
      notes: 'Reconciled against the fabric invoice.\n'.repeat(80),
      overrides: { fabricCostUsd: 2600, productivityRate: 500, customer: 'Kittrich Corp.' },
    }));
    assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
    // Two pages: the note alone is longer than one.
    assert.ok((buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length >= 2);
  });

  test('a losing order renders its perfect price', async () => {
    const buf = await render(order({ sellPriceUsd: 0.5 }));
    assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  });
});
