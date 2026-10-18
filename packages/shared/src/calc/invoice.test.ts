import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  amountInWords, computeInvoiceTotals, formatInvoiceNumber, integerInWords, lineTotal,
  reconcileShippedAgainstOrdered, summariseSizes,
} from './invoice.js';
import { INVOICE_NUMBER_PREFIX } from '../enums.js';

const item = (quantity: number | null, unitPrice: number | null, description = 'Car stand printed cover') =>
  ({ kind: 'ITEM' as const, description, quantity, unitPrice, amount: null });
const extra = (amount: number | null, description = 'Extra piece') =>
  ({ kind: 'EXTRA' as const, description, quantity: null, unitPrice: null, amount });

describe('invoice totals', () => {
  test('the sample invoice: 122 pieces at 5.95 plus one extra piece', () => {
    const t = computeInvoiceTotals([item(122, 5.95), extra(5.95)]);
    assert.equal(t.totalQty, 122);
    assert.equal(t.subtotal, 725.9);
    assert.equal(t.extras, 5.95);
    assert.equal(t.total, 731.85);
    assert.equal(t.incomplete, false);
  });

  test('cents are exact, not floating-point residue', () => {
    assert.equal(lineTotal(item(3, 0.1)), 0.3);
    assert.equal(computeInvoiceTotals([item(3, 0.1), item(3, 0.2)]).total, 0.9);
    assert.equal(lineTotal(item(1972, 7.25)), 14297);
  });

  test('a goods line without a price has no total and marks the invoice incomplete', () => {
    const t = computeInvoiceTotals([item(100, null), item(50, 2)]);
    assert.equal(lineTotal(item(100, null)), null);
    assert.equal(t.totalQty, 150, 'the pieces are still counted');
    assert.equal(t.subtotal, 100);
    assert.equal(t.incomplete, true);
  });

  test('a discount is an extra with a negative amount', () => {
    const t = computeInvoiceTotals([item(10, 10), extra(-25, 'Discount')]);
    assert.equal(t.extras, -25);
    assert.equal(t.total, 75);
  });

  test('an extra with no amount counts for nothing and does not make the invoice incomplete', () => {
    const t = computeInvoiceTotals([item(10, 10), extra(null)]);
    assert.equal(t.total, 100);
    assert.equal(t.incomplete, false);
  });
});

describe('amount in words', () => {
  test('the sample total', () => {
    assert.equal(amountInWords(731.85), 'United States Dollar Seven Hundred Thirty One and Eighty Five Cents');
  });
  test('whole dollars end in Only', () => {
    assert.equal(amountInWords(14297), 'United States Dollar Fourteen Thousand Two Hundred Ninety Seven Only');
  });
  test('a single cent, zero, and a million', () => {
    assert.equal(amountInWords(0.01), 'United States Dollar Zero and One Cent');
    assert.equal(amountInWords(0), 'United States Dollar Zero Only');
    assert.equal(integerInWords(1_000_000), 'One Million');
    assert.equal(integerInWords(1_000_010), 'One Million Ten');
    assert.equal(integerInWords(115), 'One Hundred Fifteen');
  });
  test('rounding to the cent happens before the words', () => {
    assert.equal(amountInWords(10.005), 'United States Dollar Ten and One Cent');
  });
});

describe('numbering', () => {
  test('prefix, year and a four-digit sequence', () => {
    assert.equal(formatInvoiceNumber('INVOICE', 2026, 379, INVOICE_NUMBER_PREFIX), 'INV-2026-0379');
    assert.equal(formatInvoiceNumber('PROFORMA', 2026, 1, INVOICE_NUMBER_PREFIX), 'PI-2026-0001');
    assert.equal(formatInvoiceNumber('INVOICE', 2026, 12345, INVOICE_NUMBER_PREFIX), 'INV-2026-12345');
  });
});

describe('shipped against ordered', () => {
  test('sizes are listed in the order they are sold, and a short size is positive', () => {
    const r = reconcileShippedAgainstOrdered(
      [{ product: 'Navy', label: 'M', qty: 50 }, { product: 'Navy', label: 'S', qty: 40 }],
      [{ product: 'Navy', label: 'S', qty: 40 }, { product: 'Navy', label: 'M', qty: 48 }],
      ['S', 'M', 'L'],
    );
    assert.deepEqual(r.groups[0]!.rows.map((x) => x.label), ['S', 'M']);
    assert.equal(r.groups[0]!.rows[1]!.short, 2);
    assert.equal(r.ordered, 90);
    assert.equal(r.shipped, 88);
    assert.equal(r.short, 2);
  });

  test('a size shipped that was never ordered still appears, as over-shipped', () => {
    const r = reconcileShippedAgainstOrdered(
      [{ product: 'Navy', label: 'M', qty: 10 }],
      [{ product: 'Navy', label: 'M', qty: 10 }, { product: 'Navy', label: 'Sample', qty: 2 }],
      ['M'],
    );
    assert.equal(r.groups[0]!.rows.length, 2);
    assert.equal(r.groups[0]!.rows[1]!.label, 'Sample');
    assert.equal(r.groups[0]!.rows[1]!.short, -2);
    assert.equal(r.short, -2);
  });

  test('a product ordered but not shipped at all is wholly short', () => {
    const r = reconcileShippedAgainstOrdered(
      [{ product: 'Red', label: 'L', qty: 30 }], [], ['L'],
    );
    assert.equal(r.groups[0]!.shipped, 0);
    assert.equal(r.groups[0]!.short, 30);
  });
});

describe('the size cell', () => {
  test('a few sizes are listed, many become a range, none is null', () => {
    const order = ['XS', 'S', 'M', 'L', 'XL', '2XL'];
    assert.equal(summariseSizes(['M', 'S', 'S'], order), 'S, M');
    assert.equal(summariseSizes(['XS', 'S', 'M', 'L', 'XL', '2XL'], order), 'XS – 2XL');
    assert.equal(summariseSizes([], order), null);
    assert.equal(summariseSizes(['Sample'], order), 'Sample');
  });
});
