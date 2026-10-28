/**
 * Reading purchase orders printed as item blocks, not a grid.
 *
 * The fixture is shaped on a real ERP printout (a JD Edwards purchase order,
 * Kittrich PO 73287) that the table reader could not read: each item is a
 * priced line, then the supplier item code, then the colour and size; the
 * page header repeats on every page with a different page number; labels and
 * values share cells ("Ship To Acme Pomona"). Names and figures are invented.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectDayFirst, splitColourSize, findPricedNumbers, findBoilerplate, boilerplateKey,
  splitAtLabels, readPoHeader, readPoLines, poLinesToOrder, orderSizes,
  inWearingOrder, sizeRank, sizeAliasFor,
} from './po-lines.js';
import { extractFromPdf } from './pdf-extractor.js';

const at = (text: string, x: number, y: number) => ({ text, x, y, width: text.length * 4.5 });

describe('the pieces', () => {
  test('a priced line is found by its arithmetic, wherever its columns sit', () => {
    const p = findPricedNumbers(['1.000', '0', 'HARROGATE', 'SHIRT', '12.0000', 'EA', '5.0000', 'EA', '60.00', '5/30/2022']);
    assert.deepEqual([p?.qty, p?.price, p?.ext], [12, 5, 60]);
  });

  test('a line whose numbers do not multiply out is not priced', () => {
    assert.equal(findPricedNumbers(['Branch/Plant', '1000', 'Page', '2']), null);
  });

  test('colour and size are split from the end', () => {
    assert.deepEqual(splitColourSize('ROY/WHT YOUTH SMALL'), { colour: 'ROY/WHT', size: 'Youth Small' });
    assert.deepEqual(splitColourSize('BLACK/WH ADULT MEDIUM'), { colour: 'BLACK/WH', size: 'Adult Medium' });
    assert.equal(splitColourSize('CHARCOAL').size, null);
  });

  test('the document decides day or month first', () => {
    assert.equal(detectDayFirst(['4/28/2022', '5/6/2022']), false);
    assert.equal(detectDayFirst(['28/4/2022']), true);
  });

  test('a running header is boilerplate even with a different page number', () => {
    const pages = [
      [{ text: 'Purchase Order Print Page - 1', y: 745 }, { text: 'BLACK/WH ADULT MEDIUM', y: 400 }],
      [{ text: 'Purchase Order Print Page - 2', y: 745 }, { text: 'BLACK/WH ADULT MEDIUM', y: 300 }],
    ];
    const b = findBoilerplate(pages);
    assert.ok(b.has(boilerplateKey('Purchase Order Print Page - 7')));
    // An item line that recurs on two pages, at a different height, is data.
    assert.ok(!b.has(boilerplateKey('BLACK/WH ADULT MEDIUM')));
  });

  test('a label inside a cell becomes a cell of its own', () => {
    const cells = splitAtLabels([{ text: '4/28/2022 Freight OCC Ocean Collect', x: 72, end: 230 }]);
    assert.deepEqual(cells.map((c) => c.text), ['4/28/2022', 'Freight', 'OCC Ocean Collect']);
  });
});

describe('the header', () => {
  const lines = [
    [{ text: 'R43500', x: 23 }, { text: 'Acme Corporation', x: 210 }, { text: '4/28/2022', x: 498 }],
    [{ text: 'Order Number', x: 426 }, { text: '73287 000', x: 515 }, { text: 'OI', x: 564 }],
    [{ text: 'Shipped From AGE (AL SHIMAA GARMENT & EMBROIDERY)', x: 24 }, { text: 'Ship To Acme Pomona', x: 300, end: 390 }],
    [{ text: 'STREET 5-PUBLIC FREE ZONE', x: 78 }, { text: '1585 West Mission Blvd.', x: 330 }],
    [{ text: 'Pomona CA 91766', x: 330 }],
    [{ text: 'Ordered', x: 30 }, { text: '4/28/2022 Freight OCC Ocean Collect', x: 72, end: 230 }],
    [{ text: 'Requested 5/30/2022 Order Taken By', x: 30, end: 180 }, { text: 'Currency Code USD', x: 210, end: 285 }],
  ];
  const h = readPoHeader(lines, false);

  test('the PO number is the first code after its label', () => assert.equal(h.poNumber, '73287'));
  test('dates are read month-first when the document is', () => {
    assert.equal(h.orderDate?.toISOString().slice(0, 10), '2022-04-28');
    assert.equal(h.deliveryDate?.toISOString().slice(0, 10), '2022-05-30');
  });
  test('the buyer is the company in the letterhead, not us', () => assert.equal(h.client, 'Acme Corporation'));
  test('the ship-to block is read down from the label', () => {
    assert.equal(h.shipTo, 'Acme Pomona, 1585 West Mission Blvd., Pomona CA 91766');
  });
  test('ocean freight is Sea, and the currency is read', () => {
    assert.equal(h.shippingMethod, 'Sea');
    assert.equal(h.currency, 'USD');
  });
});

describe('item blocks into an order', () => {
  const block = (n: number, desc: string, qty: string, price: string, ext: string, code: string, colourSize: string) => [
    [{ text: `${n}.000`, x: 33 }, { text: `0 ${desc}`, x: 65 }, { text: `${qty} EA`, x: 254 }, { text: `${price} EA`, x: 354 }, { text: `${ext} 5/30/2022`, x: 442 }],
    [{ text: code, x: 72 }],
    [{ text: colourSize, x: 72 }],
  ];
  const lines = [
    ...block(1, 'HARROGATE SHIRT', '12.0000', '5.0000', '60.00', 'XRA-1006RW-YSM', 'ROY/WHT YOUTH SMALL'),
    ...block(2, 'BRITANNIA SHIRT FEMALE', '18.0000', '4.7800', '86.04', 'XRA-1038BL-AMD', 'BLACK/WH ADULT MEDIUM'),
    ...block(3, 'BRITANNIA SHIRT FEMALE', '18.0000', '4.7800', '86.04', 'XRA-1038BL-ASM', 'BLACK/WH ADULT SMALL'),
  ];
  const read = readPoLines(lines, new Set(), false);

  test('every block is one line with its code, colour and size', () => {
    assert.equal(read.length, 3);
    assert.deepEqual(read.map((l) => [l.itemCode, l.colour, l.size, l.quantity]), [
      ['XRA-1006RW-YSM', 'ROY/WHT', 'Youth Small', 12],
      ['XRA-1038BL-AMD', 'BLACK/WH', 'Adult Medium', 18],
      ['XRA-1038BL-ASM', 'BLACK/WH', 'Adult Small', 18],
    ]);
  });

  test('several styles become one row per style and colour, totals kept', () => {
    const o = poLinesToOrder(read);
    assert.equal(o.totalQty, 48);
    assert.equal(o.totalValue, 232.08);
    assert.deepEqual(o.matrix?.sizes, ['Youth Small', 'Adult Small', 'Adult Medium']);
    assert.deepEqual(o.matrix?.rows.map((r) => [r.color, r.total]), [
      ['Harrogate Shirt — ROY/WHT', 12],
      ['Britannia Shirt Female — BLACK/WH', 36],
    ]);
    assert.equal(o.pricesVary, true);
    assert.equal(o.pricePerPiece, Math.round((232.08 / 48) * 10000) / 10000);
  });
});

describe('a two-page ERP purchase order, end to end', () => {
  const header = (page: number) => [
    at('R43500', 23, 760), at('Acme Corporation', 210, 757), at('4/28/2022', 498, 760),
    at('Purchase Order Print', 210, 745), at('Page -', 498, 745), at(String(page), 553, 745),
    at('Order Number', 426, 727), at('73287', 515, 727), at('000', 540, 727), at('OI', 564, 727),
  ];
  const item = (y: number, n: number, desc: string, qty: number, price: number, code: string, colourSize: string) => [
    at(`${n}.000`, 33, y), at(`0 ${desc}`, 65, y), at(`${qty}.0000`, 254, y), at('EA', 285, y),
    at(price.toFixed(4), 354, y), at('EA', 382, y), at((qty * price).toFixed(2), 442, y), at('5/30/2022', 466, y),
    at(code, 72, y - 18), at(colourSize, 72, y - 30),
  ];
  const page1 = [
    ...header(1),
    at('Ship To', 300, 700), at('Acme Pomona', 330, 700), at('1585 West Mission Blvd.', 330, 688), at('Pomona CA 91766', 330, 676),
    at('Ordered', 30, 574), at('4/28/2022', 72, 574), at('Freight', 108, 574), at('OCC', 138, 574), at('Ocean Collect', 162, 574),
    at('Requested', 30, 562), at('5/30/2022', 72, 562),
    at('Line', 29, 521), at('Description', 131, 521), at('Ordered', 241, 521), at('Unit Price', 328, 521), at('Extended Price', 406, 521),
    ...item(498, 1, 'HARROGATE SHIRT', 12, 5, 'XRA-1006RW-YSM', 'ROY/WHT YOUTH SMALL'),
    ...item(456, 2, 'BRITANNIA SHIRT FEMALE', 18, 4.78, 'XRA-1038BL-AMD', 'BLACK/WH ADULT MEDIUM'),
  ];
  const page2 = (total: string) => [
    ...header(2),
    // The same colour and size as on page 1, at another height: data, not furniture.
    ...item(600, 3, 'CLASSICO KEEPER TRS', 24, 11.5, 'XRA-2001BL-AMD', 'BLACK/WH ADULT MEDIUM'),
    at('Total Order', 300, 400), at(total, 442, 400),
  ];
  const read = (total = '422.04') => extractFromPdf(Buffer.alloc(0), {
    reader: async () => [{ pageNumber: 1, items: page1 }, { pageNumber: 2, items: page2(total) }],
  });

  test('the header fields are read', async () => {
    const f = (await read()).fields;
    assert.equal(f.poNumber, '73287');
    assert.equal(f.clientName, 'Acme Corporation');
    assert.equal((f.poDate as Date).toISOString().slice(0, 10), '2022-04-28');
    assert.equal((f.requiredDeliveryDate as Date).toISOString().slice(0, 10), '2022-05-30');
    assert.equal(f.shippingAddress, 'Acme Pomona, 1585 West Mission Blvd., Pomona CA 91766');
    assert.equal(f.shippingMethod, 'Sea');
  });

  test('every line reaches the quantity grid, with its colour and size', async () => {
    const r = await read();
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.equal(m.computedTotal, 54);
    assert.deepEqual(m.rows.map((x) => [x.color, x.cells]), [
      ['Harrogate Shirt — ROY/WHT', { 'Youth Small': 12 }],
      ['Britannia Shirt Female — BLACK/WH', { 'Adult Medium': 18 }],
      ['Classico Keeper Trs — BLACK/WH', { 'Adult Medium': 24 }],
    ]);
    assert.equal(r.lineItems.length, 3);
  });

  test('the read total matches the printed one, so no mismatch is reported', async () => {
    const r = await read();
    assert.ok(!r.issues.some((i) => /document's total/.test(i.message)), r.issues.map((i) => i.message).join('\n'));
    assert.equal(r.fields.pricePerPieceUsd, Math.round((422.04 / 54) * 10000) / 10000);
  });

  test('a read total that differs from the printed one is reported', async () => {
    const r = await read('426.04');
    assert.ok(r.issues.some((i) => /document's total is \$426\.04/.test(i.message)));
  });
});

describe('a document\'s size labels against the order\'s', () => {
  const order = ['Youth XS', 'Youth Small', 'Youth Medium', 'Youth Large', 'Adult', 'Adult Small', 'Adult Medium', 'Adult Large', 'Adult XL', 'One Size'];
  test('the laying sheet\'s youth codes and bare adult letters find the order\'s names', () => {
    assert.deepEqual(sizeAliasFor(['YXS', 'YS', 'YM', 'YL', 'M', 'L'], order), {
      YXS: 'Youth XS', YS: 'Youth Small', YM: 'Youth Medium', YL: 'Youth Large', M: 'Adult Medium', L: 'Adult Large',
    });
  });
  test('a name the order already uses, or one nothing matches, is left alone', () => {
    assert.deepEqual(sizeAliasFor(['Youth XS', 'XXL', '2X-SMALL'], order), {});
    // Two candidates for a bare word: no guess — unless the document writes
    // youth sizes as YM, in which case a bare M is the grown one.
    assert.deepEqual(sizeAliasFor(['M'], ['Youth Medium', 'Adult Medium']), {});
    assert.deepEqual(sizeAliasFor(['YM', 'M'], ['Youth Medium', 'Adult Medium']), { YM: 'Youth Medium', M: 'Adult Medium' });
    assert.deepEqual(sizeAliasFor(['YM', 'M'], ['Youth Medium', 'Adult Medium', 'Men Medium']), { YM: 'Youth Medium' });
    assert.deepEqual(sizeAliasFor(['youth xs'], order), { 'youth xs': 'Youth XS' });
  });
});

describe('sizes in wearing order', () => {
  test('known sizes are sorted, raw labels and all', () => {
    assert.deepEqual(orderSizes(['XL', 'L', 'M']), ['M', 'L', 'XL']);
    assert.deepEqual(orderSizes(['Adult Small', 'Youth LG', 'Youth S']), ['Youth S', 'Youth LG', 'Adult Small']);
    assert.deepEqual(orderSizes(['32', '28', '30']), ['28', '30', '32']);
  });

  test("a label the key cannot place keeps the document's order for the whole grid", () => {
    assert.deepEqual(orderSizes(['YOUTH 2X-SMALL', 'L', 'M']), ['YOUTH 2X-SMALL', 'L', 'M']);
  });
});

describe('sizes shown smallest on the left', () => {
  const axis = (names: string[]) => names.map((name, position) => ({ id: name, name, position }));
  const shown = (names: string[]) => inWearingOrder(axis(names)).map((s) => s.name);

  test('a reversed or shuffled grid is put in wearing order', () => {
    assert.deepEqual(shown(['XL', 'L', 'M', 'S']), ['S', 'M', 'L', 'XL']);
    assert.deepEqual(shown(['L', 'S', '3XL', 'M', 'XS', 'XL', '2XL']), ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL']);
    assert.deepEqual(shown(['12', '8', '10']), ['8', '10', '12']);
  });

  test('the factory youth codes come before adult sizes', () => {
    assert.deepEqual(shown(['S', 'YL', 'M', 'YS', '2YXS', 'YM', 'YXS']), ['2YXS', 'YXS', 'YS', 'YM', 'YL', 'S', 'M']);
    assert.ok(sizeRank('YM')! < sizeRank('S')!);
  });

  test('combined sizes sit between their halves', () => {
    assert.deepEqual(shown(['L/XL', 'S', 'S/M', 'M', 'L']), ['S', 'S/M', 'M', 'L', 'L/XL']);
  });

  test('a label nobody can rank keeps its place; the rest sort around it', () => {
    assert.deepEqual(shown(['M', 'S', 'Custom-Z', 'XS']), ['XS', 'S', 'Custom-Z', 'M']);
  });

  test('waist / length sizes go by waist, then length', () => {
    assert.deepEqual(shown(['30/34', '28/30', '28/34', '30/30', '28/32', '30/32']), ['28/30', '28/32', '28/34', '30/30', '30/32', '30/34']);
  });

  test('a combined youth size stays with the youth sizes', () => {
    assert.deepEqual(shown(['Youth XL', 'Youth S/M', 'S', 'Youth XS']), ['Youth XS', 'Youth S/M', 'Youth XL', 'S']);
    assert.deepEqual(shown(['YL', 'YS/M', 'YXS', 'S']), ['YXS', 'YS/M', 'YL', 'S']);
  });

  test('any count of X: 3XS and 4XS, 6XL and up', () => {
    assert.deepEqual(shown(['6XL', '5XL', '4XL']), ['4XL', '5XL', '6XL']);
    assert.deepEqual(shown(['4XS', 'XS', '6XL', 'XL', '3XS', 'XXS']), ['4XS', '3XS', 'XXS', 'XS', 'XL', '6XL']);
  });

  test('a combined size never ties with a single one', () => {
    assert.deepEqual(shown(['M', 'S/M/L', 'S', 'L']), ['S', 'M', 'S/M/L', 'L']);
  });

  test('positions are renumbered to match what is shown', () => {
    assert.deepEqual(inWearingOrder(axis(['L', 'S'])).map((s) => [s.name, s.position]), [['S', 0], ['L', 1]]);
  });
});
