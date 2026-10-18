/**
 * The invoice builder, by value, against the sample invoice the section was
 * written from: 122 car-stand covers at 5.95 in three cartons.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeInvoiceTotals, issueBlockers, type CompanyProfileDto } from '@opsflow/shared';
import {
  buildInvoiceDocument, cartonsFingerprint, defaultCoverNote, manifestFingerprint,
  type BuildOrder, type BuildPackingList, type BuildShipment,
} from './invoice-service.js';

const profile: CompanyProfileDto = {
  name: 'Soccertex', tagline: 'Readymade garments', address: 'Giza, Egypt', taxId: '000-000-000',
  email: 'sales@soccertex.biz', phone: null, website: null,
  bankDetails: 'Bank: AAIB\nIBAN: EG00', invoiceTerms: 'Goods are of Egyptian origin.\nPrices are valid for 14 days.',
  paymentTerms: 'COD', updatedAt: null,
};

const order = (over: Partial<BuildOrder> = {}): BuildOrder => ({
  id: 'o1', poNumber: 'SO-2026-0138', orderName: 'Car stand printed cover', styleNumber: null,
  externalReference: 'غطاء ميش مطبوع ستاند', pricePerPieceUsd: 5.95, promisedShippingDate: null,
  billingAddress: null,
  client: { name: 'Champs Land', billingAddress: 'Abu Rawash, Giza', email: 'buyer@champs.example' },
  colors: [{ id: 'c1', name: 'Black', productName: null, position: 0 }],
  sizes: [{ id: 's1', name: 'One size', position: 0 }],
  orderCells: [{ orderColorId: 'c1', orderSizeId: 's1', qty: 122 }],
  ...over,
});

const packingList = (): BuildPackingList => ({
  id: 'pl1', reference: 'EXP-0110', approved: true,
  cartons: [
    { id: 'k1', cartonNumber: 'CTN-000176', cartonSize: null, orderColorId: 'c1', orderSizeId: 's1', qty: 40, netKg: 24.8, grossKg: 25.8, lines: [] },
    { id: 'k2', cartonNumber: 'CTN-000177', cartonSize: null, orderColorId: 'c1', orderSizeId: null, qty: 42, netKg: 24, grossKg: 25,
      lines: [{ orderSizeId: 's1', sizeLabel: null, qty: 40 }, { orderSizeId: null, sizeLabel: 'Spare', qty: 2 }] },
    { id: 'k3', cartonNumber: 'CTN-000178', cartonSize: null, orderColorId: 'c1', orderSizeId: 's1', qty: 40, netKg: 24, grossKg: 25, lines: [] },
  ],
});

const shipment = (over: Partial<BuildShipment> = {}): BuildShipment => ({
  id: 'sh1', status: 'SHIPPED', qty: 122, actualShippingDate: new Date('2026-10-03T09:30:00Z'),
  awbNumber: null, trackingNumber: null, containerSeal: null, ...over,
});

describe('an invoice built from a packed, shipped order', () => {
  const doc = buildInvoiceDocument({ kind: 'INVOICE', order: order(), packingList: packingList(), shipment: shipment(), profile });

  test('one goods line per colour, at the shipped quantity and the order price', () => {
    assert.equal(doc.lines.length, 1);
    const [line] = doc.lines;
    assert.equal(line!.description, 'Car stand printed cover — Black');
    assert.equal(line!.quantity, 122);
    assert.equal(line!.unitPrice, 5.95);
    assert.equal(line!.size, 'One size, Spare');
    assert.equal(computeInvoiceTotals(doc.lines).total, 725.9);
  });

  test('the manifest is the cartons, with a mixed carton broken down', () => {
    assert.equal(doc.manifest.length, 3);
    assert.deepEqual(doc.manifest.map((c) => c.pieces), [40, 42, 40]);
    assert.deepEqual(doc.manifest[1]!.contents, [{ label: 'One size', qty: 40 }, { label: 'Spare', qty: 2 }]);
    assert.equal(doc.manifest[0]!.netKg, 24.8);
  });

  test('the reconciliation says the spare was over-shipped and the rest balanced', () => {
    assert.equal(doc.reconciliation.length, 1);
    const g = doc.reconciliation[0]!;
    assert.equal(g.ordered, 122);
    assert.equal(g.shipped, 122);
    assert.deepEqual(g.rows.map((r) => [r.label, r.short]), [['One size', 2], ['Spare', -2]]);
  });

  test('dated the day the goods left, referenced by the packing list, billed to the client', () => {
    assert.equal(doc.date.toISOString(), '2026-10-03T00:00:00.000Z');
    assert.equal(doc.shipmentRef, 'EXP-0110');
    assert.equal(doc.billTo, 'Champs Land');
    assert.equal(doc.billToAddress, 'Abu Rawash, Giza');
    assert.equal(doc.customerReference, 'غطاء ميش مطبوع ستاند');
    assert.equal(doc.paymentTerms, 'COD');
    assert.equal(doc.terms, profile.invoiceTerms);
    assert.deepEqual(doc.warnings, []);
  });
});

describe('what the builder refuses to invent', () => {
  test('no price: the line has no rate and the draft says so', () => {
    const doc = buildInvoiceDocument({ kind: 'INVOICE', order: order({ pricePerPieceUsd: null }), packingList: packingList(), shipment: shipment(), profile });
    assert.equal(doc.lines[0]!.unitPrice, null);
    assert.ok(doc.warnings.some((w) => w.includes('no unit price')));
    assert.equal(computeInvoiceTotals(doc.lines).incomplete, true);
  });

  test('no cartons: one line at the shipment quantity, no manifest, and a warning', () => {
    const doc = buildInvoiceDocument({ kind: 'INVOICE', order: order(), packingList: null, shipment: shipment({ qty: 120 }), profile });
    assert.equal(doc.lines.length, 1);
    assert.equal(doc.lines[0]!.quantity, 120);
    assert.equal(doc.manifest.length, 0);
    assert.ok(doc.warnings.some((w) => w.includes('No packing list')));
  });

  test('nothing packed or shipped: the ordered quantities, flagged', () => {
    const doc = buildInvoiceDocument({ kind: 'INVOICE', order: order(), packingList: null, shipment: null, profile, now: new Date('2026-10-18T12:00:00Z') });
    assert.equal(doc.lines[0]!.quantity, 122);
    assert.equal(doc.date.toISOString(), '2026-10-18T00:00:00.000Z');
    assert.ok(doc.warnings.some((w) => w.includes('Nothing has been packed')));
    assert.ok(doc.warnings.some((w) => w.includes('No shipment')));
  });

  test('cartons and shipment disagree: the cartons win and the difference is named', () => {
    const doc = buildInvoiceDocument({ kind: 'INVOICE', order: order(), packingList: packingList(), shipment: shipment({ qty: 100 }), profile });
    assert.equal(doc.lines[0]!.quantity, 122);
    assert.ok(doc.warnings.some((w) => w.includes('122') && w.includes('100')));
  });

  test('an unapproved packing list is a warning, not a refusal', () => {
    const pl = { ...packingList(), approved: false };
    const doc = buildInvoiceDocument({ kind: 'INVOICE', order: order(), packingList: pl, shipment: shipment(), profile });
    assert.equal(doc.lines.length, 1);
    assert.ok(doc.warnings.some((w) => w.includes('not been approved')));
  });
});

describe('a proforma', () => {
  test('is priced on the ordered quantities, with no manifest and nothing to reconcile', () => {
    const o = order({
      colors: [{ id: 'c1', name: 'Navy', productName: null, position: 0 }, { id: 'c2', name: 'Red', productName: 'STRIKERS JERSEY', position: 1 }],
      sizes: [{ id: 's', name: 'S', position: 0 }, { id: 'm', name: 'M', position: 1 }],
      orderCells: [
        { orderColorId: 'c1', orderSizeId: 's', qty: 10 }, { orderColorId: 'c1', orderSizeId: 'm', qty: 20 },
        { orderColorId: 'c2', orderSizeId: 'm', qty: 5 },
      ],
    });
    const doc = buildInvoiceDocument({ kind: 'PROFORMA', order: o, packingList: packingList(), shipment: shipment(), profile });
    assert.deepEqual(doc.lines.map((l) => [l.description, l.size, l.quantity]), [
      ['Car stand printed cover — Navy', 'S, M', 30],
      ['STRIKERS JERSEY — Red', 'M', 5],
    ]);
    assert.equal(doc.manifest.length, 0);
    assert.equal(doc.reconciliation.length, 0);
    assert.equal(doc.shipmentRef, null);
    assert.deepEqual(doc.warnings, []);
  });

  test('a colour whose product name already names the colour is not named twice', () => {
    const o = order({ colors: [{ id: 'c1', name: 'Black', productName: 'Black car stand cover', position: 0 }] });
    const doc = buildInvoiceDocument({ kind: 'PROFORMA', order: o, packingList: null, shipment: null, profile });
    assert.equal(doc.lines[0]!.description, 'Black car stand cover');
  });
});

describe('the cover note and the blockers', () => {
  test('the note names the number, the shipment and the order', () => {
    const note = defaultCoverNote({ kind: 'INVOICE', number: 'INV-2026-0379', billTo: 'Champs Land', shipmentRef: 'EXP-0110', poNumber: 'SO-2026-0138', orderName: 'Car stand printed cover', qty: 122 });
    assert.ok(note.startsWith('Dear Champs Land,'));
    assert.ok(note.includes('invoice INV-2026-0379 for shipment EXP-0110'));
    assert.ok(note.includes('PO SO-2026-0138 · Car stand printed cover — 122 pcs'));
  });

  test('a draft with no rate, no quantity or stale cartons cannot be issued', () => {
    const base = {
      id: 'i', kind: 'INVOICE' as const, status: 'DRAFT' as const, number: 'INV-2026-0001', date: '', dueDate: null, paymentTerms: null,
      order: { id: 'o', poNumber: 'P', orderName: 'N', styleNumber: null, clientName: 'C' }, shipmentId: null, packingListId: null,
      billTo: 'C', billToAddress: null, billToEmail: null, customerReference: null, shipmentRef: null, shippedOn: null,
      coverNote: null, terms: null, bankDetails: null, notes: null, seller: profile, manifest: [], reconciliation: [], warnings: [],
      totals: { totalQty: 0, subtotal: 0, extras: 0, total: 0, incomplete: false }, totalInWords: '',
      preparedByName: null, issuedByName: null, issuedAt: null, sentAt: null, voidedAt: null, voidReason: null,
      stale: false, createdAt: '', updatedAt: '',
    };
    const line = (quantity: number | null, unitPrice: number | null) =>
      ({ id: 'l', kind: 'ITEM' as const, description: 'x', size: null, quantity, unitPrice, amount: null, lineTotal: null, position: 0 });
    assert.equal(issueBlockers({ ...base, lines: [line(10, 2)] }).length, 0);
    assert.equal(issueBlockers({ ...base, lines: [] }).length, 1);
    assert.ok(issueBlockers({ ...base, lines: [line(10, null)] })[0]!.includes('rate'));
    assert.ok(issueBlockers({ ...base, lines: [line(0, 2)] })[0]!.includes('quantity'));
    assert.ok(issueBlockers({ ...base, lines: [line(10, 2)], stale: true })[0]!.includes('Rebuild'));
  });

  test('a manifest matches the cartons it was built from and nothing else', () => {
    const doc = buildInvoiceDocument({ kind: 'INVOICE', order: order(), packingList: packingList(), shipment: shipment(), profile });
    const cartons = packingList().cartons.map((c) => ({ cartonNumber: c.cartonNumber, qty: c.qty }));
    assert.equal(manifestFingerprint(doc.manifest), cartonsFingerprint(cartons));
    cartons[1]!.qty = 41;
    assert.notEqual(manifestFingerprint(doc.manifest), cartonsFingerprint(cartons));
  });
});
