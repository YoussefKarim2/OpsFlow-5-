/**
 * Regressions from the importer audit of 2026-11-05: each case is a file a
 * customer or the factory could send that read a wrong number, a wrong colour
 * or nothing at all, with nothing said.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { extractTabular } from './tabular-extractor.js';
import { extractWorkbook, toNumber, toPieces } from './extractor.js';
import { AGE_ORDER_V1 } from './profiles.js';
import { extractFromPdf } from './pdf-extractor.js';
import { readPackingDocument } from './packing-reader.js';
import { csvIsEuropean } from './open-workbook.js';
import { extractLayingMarking } from './laying-extractor.js';
import { isTotalsLabel, isNonColourLabel } from './row-labels.js';
import { refuseUnbelievable } from '../../routes/import.js';

async function book(rows: unknown[][], shape?: (ws: ExcelJS.Worksheet) => void, name = 'PO'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  for (const r of rows) ws.addRow(r);
  shape?.(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function order(rows: unknown[][], shape?: (ws: ExcelJS.Worksheet) => void) {
  const r = await extractTabular(await book(rows, shape));
  const m = r.matrices.find((x) => x.ledger === 'ORDER');
  return { r, m, rows: m?.rows.map((x) => [x.color, x.cells] as const) ?? [] };
}

/** A PDF of lines of cells, each cell 80pt to the right of the last. */
function pdf(lines: string[][]): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(10);
    let y = 50;
    for (const line of lines) {
      line.forEach((t, i) => { if (t) doc.text(t, 40 + i * 80, y, { lineBreak: false }); });
      y += 18;
    }
    doc.end();
  });
}

describe('1. an English CSV with three decimals is not European', () => {
  test('prices of 4.125 stay 4.125', async () => {
    const csv = 'Style,Colour,Size,Qty,Unit Price\nA1,Navy,M,100,4.125\nA1,Navy,L,100,4.125\nA1,Red,M,50,3.875\n';
    const r = await extractTabular(Buffer.from(csv));
    const m = r.matrices[0]!;
    assert.deepEqual(m.rows.map((x) => x.unitPrice), [4.125, 3.875]);
    assert.equal(m.computedTotal, 250);
  });

  test('carton weights of 12.500 kg stay 12.5', async () => {
    const csv = 'C/No,Colour,S,M,L,Total,N.W,G.W\n1,Navy,10,10,10,30,10.250,12.500\n2,Navy,10,10,10,30,10.250,12.500\n';
    const r = await readPackingDocument(Buffer.from(csv), 'pack.csv');
    assert.deepEqual(r.cartons.map((c) => [c.netKg, c.grossKg]), [[10.25, 12.5], [10.25, 12.5]]);
  });

  test('marker lengths of 5.125 m stay 5.125', async () => {
    const csv = 'Marker No,Fabric,Color,Size Ratio,Layers,Marker Length,Total Length\nM1,Jersey,Navy,S1 M2 L1,40,5.125,205.000\n';
    const r = await extractLayingMarking(Buffer.from(csv));
    assert.equal(r.rows[0]!.markerLengthM, 5.125);
  });

  test('a decimal comma is still European evidence, and a semicolon file still reads 1.200 as 1200', () => {
    assert.equal(csvIsEuropean('a,b\n"12,5","1.200"\n', ','), true);
    assert.equal(csvIsEuropean('a,b\n4.125,12.500\n', ','), false);
    assert.equal(csvIsEuropean('a;b\nNavy;1.200\n', ';'), true);
  });

  test('a comma CSV with quoted decimal commas reads them European', async () => {
    const r = await extractTabular(Buffer.from('Colour,Size,Qty,Price\nNavy,M,"1.200","4,50"\nRed,M,"1.500","4,50"\n'));
    const m = r.matrices[0]!;
    assert.equal(m.computedTotal, 2700);
    assert.deepEqual(m.rows.map((x) => x.unitPrice), [4.5, 4.5]);
  });
});

describe('2. a PDF totals row is never a colour', () => {
  for (const label of ['Total:', 'Subtotal']) {
    test(`"${label}" under a size grid is not read as a colour`, async () => {
      const r = await extractFromPdf(await pdf([
        ['PO Number: 4455'], [''], ['Colour', 'S', 'M', 'L', 'XL'],
        ['Navy', '10', '20', '30', '40'], ['Black', '5', '5', '5', '5'], [label, '15', '25', '35', '45'],
      ]));
      const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
      assert.deepEqual(m.rows.map((x) => x.color), ['Navy', 'Black']);
      assert.equal(m.computedTotal, 120);
    });
  }

  test('"Navy Total" rows are not colours', async () => {
    const r = await extractFromPdf(await pdf([
      ['PO Number: 4457'], [''], ['Colour', 'S', 'M', 'L'],
      ['Navy', '10', '20', '30'], ['Navy Total', '10', '20', '30'], ['Black', '5', '5', '5'], ['Black Total', '5', '5', '5'],
    ]));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.deepEqual(m.rows.map((x) => x.color), ['Navy', 'Black']);
    assert.equal(m.computedTotal, 75);
  });
});

describe('3. a quantity counted in dozens', () => {
  test('long: 10 DZ at $48 is 120 pieces at $4, and said', async () => {
    const { r, m } = await order([['Style', 'Colour', 'Size', 'Qty', 'Unit', 'Unit Price'], ['A', 'Navy', 'M', 10, 'DZ', 48], ['A', 'Navy', 'L', 5, 'DZ', 48]]);
    assert.deepEqual(m!.rows[0]!.cells, { M: 120, L: 60 });
    assert.equal(m!.rows[0]!.unitPrice, 4);
    assert.equal(r.fields.pricePerPieceUsd, 4);
    assert.ok(r.issues.some((i) => i.level === 'INFO' && /dozen/i.test(i.message)));
  });

  test('wide: a DOZ row is twelve times its figures', async () => {
    const { m } = await order([['Colour', 'S', 'M', 'Unit', 'Price'], ['Navy', 1, 2, 'DOZ', 24], ['Red', 3, 3, 'PCS', 2]]);
    assert.deepEqual(m!.rows.map((x) => [x.color, x.cells, x.unitPrice]), [['Navy', { S: 12, M: 24 }, 2], ['Red', { S: 3, M: 3 }, 2]]);
  });
});

describe('4. dates that are not dates are not invented', () => {
  test('"Sep-26" and "Week 38" in the header block read as no date', async () => {
    const { r } = await order([['PO Number', 'PO-881'], ['Delivery Date', 'Sep-26'], ['Order Date', 'Week 38'], [], ['Colour', 'Size', 'Qty'], ['Navy', 'M', 10], ['Navy', 'L', 10]]);
    assert.equal(r.fields.requiredDeliveryDate ?? null, null);
    assert.equal(r.fields.poDate ?? null, null);
  });
});

describe('5. Nike colours called "Total …"', () => {
  test('"Total Orange" in a grid is a colour, and the table goes on', async () => {
    const { m, rows } = await order([
      ['Style', 'Colour', 'S', 'M', 'L'], ['ST1', 'Navy', 10, 20, 30], ['ST1', 'Total Orange', 5, 5, 5], ['ST1', 'Black', 1, 2, 3], ['Total', '', 16, 27, 38],
    ]);
    assert.deepEqual(rows.map(([c]) => c), ['Navy', 'Total Orange', 'Black']);
    assert.equal(m!.computedTotal, 81);
    assert.equal(m!.sheetTotal, 81);
  });

  test('"Total Crimson" in a long table is a colour', async () => {
    const { m } = await order([['Colour', 'Size', 'Qty'], ['Navy', 'M', 10], ['Total Crimson', 'M', 20], ['Total Crimson', 'L', 20], ['Black', 'L', 5]]);
    assert.equal(m!.computedTotal, 55);
  });

  test('a total labelled in words is still a total when its numbers are the sum above', async () => {
    const { m } = await order([['Colour', 'S', 'M'], ['Navy', 10, 20], ['Red', 5, 5], ['Total pieces ordered', 15, 25]]);
    assert.deepEqual(m!.rows.map((x) => x.color), ['Navy', 'Red']);
  });

  test('a packing list carton in "Total Orange" is a carton', async () => {
    const r = await readPackingDocument(await book([
      ['C/No', 'Colour', 'S', 'M', 'L', 'Total', 'G.W', 'N.W'],
      [1, 'Navy', 10, 10, 10, 30, 12, 10], [2, 'Total Orange', 10, 10, 10, 30, 12, 10], [3, 'Black', 10, 10, 10, 30, 12, 10],
    ], undefined, 'Packing'), 'p.xlsx');
    assert.deepEqual(r.cartons.map((c) => c.colour), ['Navy', 'Total Orange', 'Black']);
    assert.equal(r.totals.pieces, 90);
  });

  test('the label rule', () => {
    for (const t of ['Total', 'TOTAL:', 'Grand Total', 'Subtotal', 'Total Qty', 'Total: 1,200 pcs', 'Navy Total', 'Sum']) assert.equal(isTotalsLabel(t), true, t);
    for (const t of ['Total Orange', 'Total Crimson', 'Navy']) assert.equal(isTotalsLabel(t), false, t);
  });
});

describe('6. a style heading after a gap', () => {
  test('the group under it is read', async () => {
    const { rows } = await order([
      ['Style', 'Colour', 'S', 'M', 'L'], ['ST-100'], ['', 'Navy', 10, 10, 10], ['', 'Red', 10, 10, 10], [],
      ['ST-200'], ['', 'Navy', 20, 20, 20], ['', 'Black', 20, 20, 20],
    ]);
    assert.deepEqual(rows.map(([c]) => c), ['ST-100 — Navy', 'ST-100 — Red', 'ST-200 — Navy', 'ST-200 — Black']);
  });

  test('another table after a gap still ends the read', async () => {
    const { rows } = await order([['Colour', 'S', 'M', 'L'], ['Navy', 10, 20, 30], [], [], ['Bill of materials'], ['Item', 'Unit', 'Required'], ['Jersey fabric', 'MET', 120]]);
    assert.deepEqual(rows.map(([c]) => c), ['Navy']);
  });
});

describe('7. a style printed once per group in a size grid', () => {
  test('the blank style cells carry the style down', async () => {
    const { rows } = await order([
      ['Style', 'Colour', 'S', 'M', 'L'], ['ST-100', 'Navy', 10, 10, 10], ['', 'Red', 10, 10, 10], ['ST-200', 'Navy', 20, 20, 20], ['', 'Red', 20, 20, 20],
    ]);
    assert.deepEqual(rows.map(([c]) => c), ['ST-100 — Navy', 'ST-100 — Red', 'ST-200 — Navy', 'ST-200 — Red']);
  });
});

describe('8. commas and points by where they sit', () => {
  test('toNumber', () => {
    assert.equal(toNumber('12,5'), 12.5);
    assert.equal(toNumber('1,200'), 1200);
    assert.equal(toNumber('1,200.50'), 1200.5);
    assert.equal(toNumber('1.234,5'), 1234.5);
    assert.equal(toNumber('4.125'), 4.125);
    assert.equal(toNumber('$4.50'), 4.5);
  });

  test('toPieces reads "1.200" as twelve hundred', () => {
    assert.equal(toPieces('1.200'), 1200);
    assert.equal(toPieces('1.200 pcs'), 1200);
    assert.equal(toPieces(12), 12);
  });

  test('text quantities "1.200" in a workbook are 1200 pieces', async () => {
    const { m } = await order([['Colour', 'S', 'M'], ['Navy', '1,200', '2,400'], ['Red', '1.200', '2.400']]);
    assert.equal(m!.computedTotal, 7200);
  });

  test('packing weights "12,5" kg are twelve and a half', async () => {
    const r = await readPackingDocument(await book([
      ['C/No', 'Colour', 'S', 'M', 'Total', 'G.W', 'N.W'], [1, 'Navy', 10, 10, 20, '12,5', '10,5'], [2, 'Navy', 10, 10, 20, '12,5', '10,5'],
    ], undefined, 'Packing'), 'p.xlsx');
    assert.deepEqual(r.cartons.map((c) => [c.grossKg, c.netKg]), [[12.5, 10.5], [12.5, 10.5]]);
  });
});

describe('9. the AGE Main Order grid is read to its Totals row', () => {
  async function age(colours: number, opts: { hide?: number; totals?: boolean } = {}) {
    const wb = new ExcelJS.Workbook();
    for (const n of AGE_ORDER_V1.signature.names) {
      if (n !== 'Order Details_Coordinator' && n !== 'Main Order_Factory.Manger') wb.addWorksheet(n).addRow(['x']);
    }
    const details = wb.addWorksheet('Order Details_Coordinator');
    for (const r of [['Po No', 'P1'], ['Client', 'C'], ['Cut Percentage', 0.05]]) details.addRow(r);
    const main = wb.addWorksheet('Main Order_Factory.Manger');
    main.addRow(['Color', 'S', 'M', 'L', 'Total']);
    for (let i = 1; i <= colours; i++) main.addRow([`Colour ${i}`, 1, 1, 1, 3]);
    if (opts.totals !== false) main.addRow(['Totals', colours, colours, colours, colours * 3]);
    if (opts.hide) main.getRow(opts.hide).hidden = true;
    return extractWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
  }

  test('seventy colours are all read', async () => {
    const r = await age(70);
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.equal(m.rows.length, 70);
    assert.equal(m.computedTotal, 210);
    assert.equal(m.sheetTotal, 210);
  });

  test('a hidden row is left out and said', async () => {
    const r = await age(5, { hide: 3 });
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.equal(m.rows.some((x) => x.color === 'Colour 2'), false);
    assert.ok(r.issues.some((i) => /hidden row/.test(i.message)));
  });

  test('no Totals row is said', async () => {
    const r = await age(5, { totals: false });
    assert.ok(r.issues.some((i) => /no "Totals" row/.test(i.message)));
  });
});

describe('10. a price no column can hold is refused by name', () => {
  test('a colour priced at 1,500,000', async () => {
    const r = await extractTabular(await book([['Colour', 'Size', 'Qty', 'Unit Price'], ['Navy', 'M', 10, 1_500_000], ['Navy', 'L', 10, 1_500_000]]));
    assert.throws(() => refuseUnbelievable(r), /price of 1,500,000/);
  });

  test('a negative price', async () => {
    const r = await extractTabular(await book([['Colour', 'Size', 'Qty', 'Unit Price'], ['Navy', 'M', 10, -4], ['Navy', 'L', 10, -4]]));
    assert.throws(() => refuseUnbelievable(r), /price of -4/);
  });

  test('an ordinary price passes', async () => {
    const r = await extractTabular(await book([['Colour', 'Size', 'Qty', 'Unit Price'], ['Navy', 'M', 10, 4.5]]));
    assert.doesNotThrow(() => refuseUnbelievable(r));
  });
});

describe('11. a ratio row under the sizes is not a colour', () => {
  test('xlsx', async () => {
    const { rows } = await order([['Colour', 'S', 'M', 'L', 'XL'], ['Pack ratio', 1, 2, 2, 1], ['Navy', 10, 20, 20, 10]]);
    assert.deepEqual(rows.map(([c]) => c), ['Navy']);
  });

  test('pdf', async () => {
    const r = await extractFromPdf(await pdf([
      ['PO Number: 4456'], [''], ['Colour', 'S', 'M', 'L', 'XL'], ['Ratio', '1', '2', '2', '1'], ['Navy', '10', '20', '20', '10'], ['Black', '5', '10', '10', '5'],
    ]));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.deepEqual(m.rows.map((x) => x.color), ['Navy', 'Black']);
  });

  test('the label rule', () => {
    for (const t of ['Ratio', 'Pack ratio', 'Prepack', 'Price', 'Cartons']) assert.equal(isNonColourLabel(t), true, t);
    assert.equal(isNonColourLabel('Navy'), false);
  });
});

describe('12. a per-row Price beside a size grid', () => {
  test('is each colour’s rate', async () => {
    const { r, m } = await order([['Colour', 'S', 'M', 'L', 'Price'], ['Navy', 1, 2, 3, 4.5], ['Red', 1, 1, 1, 5]]);
    assert.deepEqual(m!.rows.map((x) => x.unitPrice), [4.5, 5]);
    assert.equal(r.fields.pricePerPieceUsd, 4.6667);
  });
});

describe('13. one size spelled two ways', () => {
  test('XXL and 2XL are one column', async () => {
    const { m } = await order([['Colour', 'Size', 'Qty'], ['Navy', 'XXL', 10], ['Red', '2XL', 5], ['Red', 'S', 5]]);
    assert.deepEqual(m!.sizes, ['S', 'XXL']);
    assert.deepEqual(m!.rows.map((x) => x.cells), [{ XXL: 10 }, { XXL: 5, S: 5 }]);
  });

  test('XXL and 2XL across a grid are one column, without a "heading twice" warning', async () => {
    const { r, m } = await order([['Colour', 'S', 'M', 'XXL', '2XL'], ['Navy', 1, 2, 3, 4]]);
    assert.deepEqual(m!.sizes, ['S', 'M', 'XXL']);
    assert.deepEqual(m!.rows[0]!.cells, { S: 1, M: 2, XXL: 7 });
    assert.equal(r.issues.some((i) => /more than once/.test(i.message)), false);
  });
});

describe('14. a header below row 30', () => {
  test('is found', async () => {
    const { m } = await order([...Array.from({ length: 34 }, (_, i) => [`Note ${i}`]), ['Colour', 'Size', 'Qty'], ['Navy', 'M', 10]]);
    assert.equal(m?.computedTotal, 10);
  });
});
