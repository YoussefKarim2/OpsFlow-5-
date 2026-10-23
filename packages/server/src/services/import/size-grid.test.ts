/**
 * Reading size grids whose numbers do not share a baseline with their colour.
 *
 * The fixture is shaped on Meyba PO 311 (two styles, a size heading each,
 * quantities printed four points above the colour name, a line of EAN
 * barcodes under them, decimal-comma prices, and "Pieces 32" on page two),
 * which imported with an empty Main Order and Cut Order. Positions are the
 * real ones; names are the document's own garment and colour words.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseAmount, isSizeLabel, readHeading, readSizeGrids, gridsToOrder, readPrintedPieces, type GridLine } from './size-grid.js';
import { extractFromPdf } from './pdf-extractor.js';
import { applyReviewedMatrix, orderPieces } from '../../routes/import.js';
import type { ExtractionResult } from './extractor.js';

const cell = (text: string, x: number, end: number) => ({ text, x, end });

describe('numbers as printed', () => {
  test('both decimal conventions', () => {
    assert.equal(parseAmount('14,00'), 14);
    assert.equal(parseAmount('448,00 USD'), 448);
    assert.equal(parseAmount('1.234,56'), 1234.56);
    assert.equal(parseAmount('1,234.56'), 1234.56);
    assert.equal(parseAmount('1,200'), 1200);
    assert.equal(parseAmount('12.0000'), 12);
    assert.equal(parseAmount('$ 5.05'), 5.05);
    assert.equal(parseAmount('Navy'), null);
  });
});

describe('size headings', () => {
  test('letters, groups, ages and numbers are sizes', () => {
    for (const s of ['XS', 'S', 'M', 'XXXXXXL', '3XL', 'Youth S', 'YM', '3-4Y', '128', 'One Size']) assert.ok(isSizeLabel(s), s);
    for (const s of ['Navy', 'Quantity', 'Price', 'Season:']) assert.ok(!isSizeLabel(s), s);
  });

  test('a heading with a merged "Quantity Price" cell still finds both columns', () => {
    const h = readHeading([
      cell('XS', 211, 221), cell('S', 259, 264), cell('M', 307, 314), cell('L', 355, 360),
      cell('Quantity Price', 691, 756), cell('Total', 774, 793),
    ]);
    assert.deepEqual(h?.sizes.map((s) => s.label), ['XS', 'S', 'M', 'L']);
    assert.ok(h?.qty != null && h.price != null && h.amount != null);
  });

  test('a line of bare numbers with no quantity heading is data, not a heading', () => {
    assert.equal(readHeading([cell('3', 307, 312), cell('5', 355, 360), cell('5', 403, 408)]), null);
  });
});

// PO 311, page 1 and 2, as the PDF's text layer groups it.
const SIZES = [
  cell('XS', 211, 221), cell('S', 259, 264), cell('M', 307, 314), cell('L', 355, 360), cell('XL', 403, 413),
  cell('XXL', 451, 466), cell('XXXL', 499, 519), cell('XXXXL', 547, 573), cell('XXXXXL', 595, 626),
  cell('XXXXXXL', 643, 679), cell('Quantity Price', 691, 756), cell('Total', 774, 793),
];
const L = (y: number, ...cells: ReturnType<typeof cell>[]): GridLine => ({ y, page: 1, cells });
const po311: GridLine[] = [
  L(401, cell('PURCHASE ORDER', 14, 139)),
  L(384, cell('Order number:', 16, 73), cell('311', 114, 127), cell('Date:', 199, 219), cell('01-10-2026', 296, 335)),
  L(335, cell('Worksop Town FC 26 Home Shirt (WOR01001)', 14, 219)),
  L(321, cell('Season:', 17, 44), cell('26/27', 261, 280), cell('Brand:', 546, 568), cell('MEYBA', 668, 691)),
  L(309, cell('Tariff No.:', 17, 50), cell('6105201000', 261, 304)),
  L(293, ...SIZES),
  L(266, cell('3', 307, 312), cell('5', 355, 360), cell('5', 403, 408)),
  L(262, cell('Black/Yellow', 99, 141), cell('020', 159, 172), cell('13', 691, 700), cell('14,00', 736, 756), cell('182,00', 774, 798)),
  L(258, cell('8721296266803 8721296266810 8721296266827', 307, 448)),
  L(223, cell('Total', 99, 118), cell('3', 307, 312), cell('5', 355, 360), cell('5', 403, 408), cell('13', 691, 701)),
  L(190, cell('Worksop Town FC 26 Away Shirt (WOR01002)', 14, 217)),
  L(175, cell('Season:', 17, 44), cell('26/27', 261, 280)),
  L(164, cell('Tariff No.:', 17, 50), cell('6105201000', 261, 304)),
  L(148, ...SIZES),
  L(119, cell('3', 307, 312), cell('6', 355, 360), cell('6', 403, 408), cell('2', 451, 456), cell('2', 499, 504)),
  L(115, cell('Navy', 99, 116), cell('002', 159, 172), cell('19', 691, 700), cell('14,00', 736, 756), cell('266,00', 774, 798)),
  L(111, cell('8721296266735 8721296266742 8721296266759 8721296266766 8721296266773', 307, 544)),
  L(73, cell('Total', 99, 118), cell('3', 307, 312), cell('6', 355, 360), cell('6', 403, 408), cell('2', 451, 456), cell('2', 499, 504), cell('19', 691, 701)),
  L(15, cell('Page 1 / 2', 792, 825)),
  { y: 529, page: 2, cells: [cell('Quantities', 340, 379), cell('Goods total', 652, 696), cell('448,00 USD', 788, 828)] },
  { y: 520, page: 2, cells: [cell('Pieces', 340, 361), cell('32', 453, 462)] },
];

describe('PO 311: quantities four points off the colour, barcodes beneath', () => {
  const blocks = readSizeGrids(po311);

  test('one grid per style, titled by the line above it', () => {
    assert.deepEqual(blocks.map((b) => [b.style, b.styleCode]), [
      ['Worksop Town FC 26 Home Shirt', 'WOR01001'],
      ['Worksop Town FC 26 Away Shirt', 'WOR01002'],
    ]);
  });

  test('each colour gets the numbers under its sizes, not the barcodes', () => {
    assert.deepEqual(blocks[0]!.rows.map((r) => [r.colour, r.cells, r.printedQty, r.price, r.amount]), [
      ['Black/Yellow', { M: 3, L: 5, XL: 5 }, 13, 14, 182],
    ]);
    assert.deepEqual(blocks[1]!.rows.map((r) => [r.colour, r.cells]), [
      ['Navy', { M: 3, L: 6, XL: 6, XXL: 2, XXXL: 2 }],
    ]);
  });

  test('every check holds, so nothing is reported', () => {
    assert.deepEqual(blocks.flatMap((b) => b.problems), []);
    assert.deepEqual(blocks.map((b) => b.printedTotal), [13, 19]);
  });

  test('the order holds both styles, the printed pieces and the price', () => {
    const o = gridsToOrder(blocks)!;
    assert.equal(o.totalQty, 32);
    assert.equal(readPrintedPieces(po311), 32);
    assert.equal(o.totalValue, 448);
    assert.equal(o.pricePerPiece, 14);
    assert.deepEqual(o.matrix.sizes, ['M', 'L', 'XL', 'XXL', 'XXXL']);
    assert.deepEqual(o.matrix.rows.map((r) => [r.color, r.total]), [
      ['Worksop Town FC 26 Home Shirt — Black/Yellow', 13],
      ['Worksop Town FC 26 Away Shirt — Navy', 19],
    ]);
  });

  test('a row whose sizes disagree with its own quantity is reported', () => {
    const wrong = po311.map((l) => (l.y === 266 ? L(266, cell('3', 307, 312), cell('5', 355, 360)) : l));
    const b = readSizeGrids(wrong);
    assert.ok(b[0]!.problems.some((p) => /add up to 8 pcs but the row says 13/.test(p)), b[0]!.problems.join('\n'));
  });
});

describe('PO 311 through the PDF extractor', () => {
  // Rebuild glyph items from the lines, one item per cell.
  const items = (page: number) => po311.filter((l) => l.page === page)
    .flatMap((l) => l.cells.map((c) => ({ text: c.text, x: c.x, y: l.y, width: c.end - c.x })));
  const read = () => extractFromPdf(Buffer.alloc(0), {
    reader: async () => [{ pageNumber: 1, items: items(1) }, { pageNumber: 2, items: items(2) }],
  });

  test('the Main Order grid is filled and matches the printed pieces', async () => {
    const r = await read();
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.equal(m.computedTotal, 32);
    assert.equal(m.sheetTotal, 32);
    assert.equal(r.fields.poNumber, '311');
    assert.equal(r.fields.pricePerPieceUsd, 14);
    assert.ok(!r.issues.some((i) => /document says|total is/.test(i.message)), r.issues.map((i) => i.message).join('\n'));
  });
});

describe('the commit guard', () => {
  const extraction = (): ExtractionResult => ({
    profileKey: 'pdf', confidence: 0.3, sheets: [], mappings: [], fields: { poNumber: '9' },
    matrices: [], lineItems: [], bom: [], lays: [], externalColors: [], costing: {}, issues: [],
  });

  test('a file with no grid has no pieces', () => assert.equal(orderPieces(extraction()), 0));

  test('the grid entered on the review screen replaces the one read', () => {
    const x = extraction();
    applyReviewedMatrix(x, { sizes: ['S', 'M'], rows: [{ color: 'Navy', cells: { S: 4, M: 6, XL: 9 } }] });
    assert.equal(orderPieces(x), 10);
    assert.deepEqual(x.matrices[0]!.rows, [{ color: 'Navy', cells: { S: 4, M: 6 }, total: 10 }]);
  });
});

describe('other grid layouts', () => {
  test('numeric kids sizes with a Qty column, quantities on the colour line', () => {
    const lines: GridLine[] = [
      L(500, cell('Article 4471 Training Top', 20, 160)),
      L(480, cell('Colour', 20, 50), cell('116', 200, 215), cell('128', 250, 265), cell('140', 300, 315), cell('152', 350, 365), cell('Qty', 420, 435)),
      L(465, cell('Royal Blue', 20, 70), cell('20', 202, 212), cell('40', 252, 262), cell('40', 302, 312), cell('20', 352, 362), cell('120', 418, 436)),
      L(450, cell('Black', 20, 45), cell('10', 202, 212), cell('15', 302, 312), cell('25', 418, 432)),
      L(435, cell('Total', 20, 40), cell('145', 418, 436)),
    ];
    const [b] = readSizeGrids(lines);
    assert.deepEqual(b!.sizes, ['116', '128', '140', '152']);
    assert.deepEqual(b!.rows.map((r) => [r.colour, r.cells, r.printedQty]), [
      ['Royal Blue', { 116: 20, 128: 40, 140: 40, 152: 20 }, 120],
      ['Black', { 116: 10, 140: 15 }, 25],
    ]);
    assert.deepEqual(b!.problems, []);
  });

  test('a grid with no colour label is one colour, "As ordered"', () => {
    const lines: GridLine[] = [
      L(480, cell('S', 200, 206), cell('M', 250, 258), cell('L', 300, 306), cell('Total', 400, 420)),
      L(465, cell('12', 200, 210), cell('24', 250, 260), cell('12', 300, 310), cell('48', 400, 410)),
    ];
    const [b] = readSizeGrids(lines);
    assert.deepEqual(b!.rows.map((r) => [r.colour, r.total]), [['As ordered', 48]]);
  });
});

describe('size headings a number after one letter, and mixed headings', () => {
  const at = (y: number, ...cells: Array<[string, number]>): GridLine => ({
    page: 1, y, cells: cells.map(([text, x]) => cell(text, x, x + Math.max(8, text.length * 5))),
  });

  test('waist and youth sizes W30 and Y10 are sizes; style codes W02 and M12 are not', () => {
    for (const s of ['W30', 'W32', 'Y6', 'Y10', 'K4']) assert.ok(isSizeLabel(s), s);
    for (const s of ['W01', 'W02', 'M12']) assert.ok(!isSizeLabel(s), s);
  });

  test('a grid headed W30 | W32 | W34 reads its quantities', () => {
    const lines = [
      at(10, ['Colour', 10], ['W30', 100], ['W32', 140], ['W34', 180], ['Qty', 220]),
      at(24, ['Indigo', 10], ['10', 100], ['20', 140], ['30', 180], ['60', 225]),
    ];
    assert.equal(gridsToOrder(readSizeGrids(lines))?.totalQty, 60);
  });

  test('a grid headed Y6 | Y8 | Y10 | Y12 reads its quantities', () => {
    const lines = [
      at(10, ['Colour', 10], ['Y6', 100], ['Y8', 140], ['Y10', 180], ['Y12', 220]),
      at(24, ['Navy', 10], ['10', 100], ['20', 140], ['30', 180], ['40', 225]),
    ];
    assert.equal(gridsToOrder(readSizeGrids(lines))?.totalQty, 100);
  });

  test('numbers that outnumber the lettered sizes are sizes: 4 | 6 | 8 | XS', () => {
    const lines = [
      at(10, ['Colour', 10], ['4', 100], ['6', 140], ['8', 180], ['XS', 220], ['Qty', 260]),
      at(24, ['Navy', 10], ['10', 100], ['20', 140], ['30', 180], ['40', 225], ['100', 262]),
    ];
    assert.equal(gridsToOrder(readSizeGrids(lines))?.totalQty, 100);
  });

  test('a "Total Qty" column heading is not the order\'s printed total', () => {
    const lines = [
      at(10, ['Colour', 10], ['S', 100], ['M', 140], ['L', 180], ['Total Qty', 220]),
      at(24, ['Navy', 10], ['10', 100], ['20', 140], ['30', 180], ['60', 225]),
      at(38, ['Red', 10], ['5', 100], ['5', 140], ['5', 180], ['15', 225]),
      at(52, ['Total pcs: 75', 10]),
    ];
    assert.equal(readPrintedPieces(lines), 75);
  });
});
