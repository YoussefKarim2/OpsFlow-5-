/**
 * A production order written one style to a block, as the factory's own
 * "Pulse Running Club" order is: a titled block per style with "Size S | 8"
 * lines, and a summary grid on the cover of the full version.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readStyleBlocks } from './style-blocks.js';
import { gridsToOrder, isSizeLabel, readHeading, readPrintedPieces, readSizeGrids, type GridLine } from './size-grid.js';
import { extractFromPdf } from './pdf-extractor.js';

/** A line of cells laid out left to right, 60pt apart. */
const line = (y: number, page: number, ...texts: string[]): GridLine => ({
  y, page,
  cells: texts.map((text, i) => ({ text, x: 40 + i * 60, end: 40 + i * 60 + text.length * 5 })),
});

const block = (y: number, page: number, n: string, title: string, colour: string, s: number, m: number, l: number): GridLine[] => [
  line(y, page, '16 PCS', `${n}. ${title} - ${colour}`),
  line(y - 12, page, 'PRODUCTION DATA'),
  line(y - 24, page, 'Color', colour),
  line(y - 36, page, 'Fabric', 'ROSETTA'),
  line(y - 48, page, 'Size S', String(s)),
  line(y - 60, page, 'Size M', String(m)),
  line(y - 72, page, 'Size L', String(l)),
  line(y - 84, page, 'Total', `${s + m + l} pcs`),
  line(y - 96, page, 'OPERATIONS / NOTES:', 'Follow approved design image.'),
];

describe('style blocks', () => {
  test('each titled block is a style with its colour and its sizes', () => {
    const lines = [...block(700, 1, '01', 'T-Shirt / Short Sleeve', 'Navy', 8, 8, 0), ...block(500, 1, '02', 'T-Shirt / Short Sleeve', 'MARRON', 8, 8, 0)];
    const blocks = readStyleBlocks(lines);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.style, 'T-Shirt / Short Sleeve');
    assert.deepEqual(blocks[0]!.rows[0]!.cells, { S: 8, M: 8 });
    assert.deepEqual(blocks[0]!.sizes, ['S', 'M'], 'a size with nothing in it is not a column');
    assert.equal(blocks[0]!.rows[0]!.printedQty, 16);
    assert.deepEqual(blocks[0]!.problems, []);
    const order = gridsToOrder(blocks)!;
    assert.equal(order.totalQty, 32);
    assert.deepEqual(order.matrix.rows.map((r) => r.color), ['Navy', 'MARRON'], 'one style: the colour alone names the row');
  });

  test('a block whose sizes do not add up to its own total says so', () => {
    const lines = block(700, 1, '05', 'Running Shorts', 'Navy', 0, 8, 8);
    lines[7] = line(700 - 84, 1, 'Total', '20 pcs');
    const blocks = readStyleBlocks(lines);
    assert.equal(blocks[0]!.rows[0]!.total, 16);
    assert.ok(blocks[0]!.problems[0]!.includes('16 pcs but the block says 20'));
  });

  test('the same block on a later page is read once', () => {
    const lines = [...block(700, 1, '01', 'Singlet / VEST', 'BROWN', 8, 8, 0), ...block(700, 2, '01', 'Singlet / VEST', 'BROWN', 8, 8, 0)];
    assert.equal(readStyleBlocks(lines).length, 1);
  });

  test('"Size S | 8" is a label and a value, not a heading of sizes S and 8', () => {
    assert.equal(readHeading(line(700, 1, 'Size S', '8').cells), null);
    assert.equal(readSizeGrids(block(700, 1, '01', 'T-Shirt', 'Navy', 8, 8, 0)).length, 0);
  });

  test('"W02" is a style code, "Youth 10" and "YS" are sizes', () => {
    assert.equal(isSizeLabel('W02'), false);
    assert.equal(isSizeLabel('M12'), false);
    assert.equal(isSizeLabel('Youth 10'), true);
    assert.equal(isSizeLabel('YS'), true);
    assert.equal(isSizeLabel('AXL'), true);
  });

  test('a printed total under a "TOTAL PCS" heading is read; a quantity under a "Pieces" column is not', () => {
    const strip = [line(700, 1, 'TOTAL STYLES', 'TOTAL PCS', 'SIZE S'), line(688, 1, '14', '224', '96')];
    assert.equal(readPrintedPieces(strip), 224);
    const table = [line(700, 1, 'Pieces', 'Shade', 'Article'), line(688, 1, '300', 'Sky Blue', 'OT-9920')];
    assert.equal(readPrintedPieces(table), null);
  });
});

describe('the Pulse production order through the PDF reader', () => {
  const at = (text: string, x: number, y: number) => ({ text, x, y, width: text.length * 5 });
  const summary = (y: number, n: number, style: string, colour: string, s: number, m: number, l: number, fabric: string) => [
    at(String(n), 45, y), at(style, 63, y), at(colour, 290, y), at(String(s), 350, y), at(String(m), 392, y), at(String(l), 434, y), at(String(s + m + l), 477, y), at(fabric, 537, y),
  ];
  const cover = [
    at('PULSE RUNNING CLUB - PRODUCTION ORDER', 45, 760),
    at('Final production issue', 45, 740), at('3 styles', 200, 740), at('Sizes S / M / L', 300, 740),
    at('TOTAL STYLES', 45, 700), at('TOTAL PCS', 160, 700), at('SIZE S', 280, 700), at('SIZE M', 380, 700), at('SIZE L', 480, 700),
    at('3', 76, 682), at('48', 178, 682), at('16', 289, 682), at('24', 392, 682), at('8', 503, 682),
    at('#', 45, 637), at('STYLE / MODEL', 138, 637), at('COLOR', 288, 637), at('S', 350, 637), at('M', 391, 637), at('L', 434, 637), at('TOTAL', 470, 637), at('FABRIC', 540, 637),
    ...summary(615, 1, 'T-Shirt / Short Sleeve', 'Navy', 8, 8, 0, 'ROSETTA'),
    ...summary(592, 2, 'W02 / Air Split Short', 'Navy', 0, 8, 8, 'WATERPROOF'),
    ...summary(569, 3, 'W03 / Stride Pocket Run Crop', 'MARRON', 8, 8, 0, 'LEGINING'),
    at('FABRIC SUMMARY', 45, 520), at('ROSETTA:', 45, 500), at('16 pcs', 120, 500),
  ];
  const detail = (page: number) => page === 1 ? cover : [
    at('PRODUCTION ORDER - STYLE DETAILS', 45, 760),
    at('16 PCS', 45, 700), at('01. T-Shirt / Short Sleeve - Navy', 120, 700),
    at('Color', 45, 676), at('Navy', 120, 676),
    at('Size S', 45, 652), at('8', 120, 652), at('Size M', 45, 640), at('8', 120, 640), at('Size L', 45, 628), at('0', 120, 628),
    at('Total', 45, 616), at('16 pcs', 120, 616),
  ];

  test('the cover grid is read in full, with style codes left as styles', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{ pageNumber: 1, items: detail(1) }, { pageNumber: 2, items: detail(2) }],
      placeholderPoNumber: 'IMPORT-TEST-0001',
    });
    const m = result.matrices[0]!;
    assert.equal(m.computedTotal, 48);
    // The cover grid names each row by its style and colour cells.
    assert.deepEqual(m.rows.map((r) => r.color), ['T-Shirt / Short Sleeve Navy', 'W02 / Air Split Short Navy', 'W03 / Stride Pocket Run Crop MARRON']);
    assert.deepEqual(m.sizes, ['S', 'M', 'L']);
    assert.equal(result.fields.poNumber, 'IMPORT-TEST-0001', 'no phrase stands in for a PO number');
    assert.equal(result.fields.orderName, 'PULSE RUNNING CLUB', 'named after the document title');
    assert.ok(!result.issues.some((i) => /says \d+ pcs in total, but/.test(i.message)), `no disagreement with the printed total: ${result.issues.map((i) => i.message).join(' | ')}`);
  });

  test('the detail pages alone are read from their blocks', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{ pageNumber: 1, items: detail(2) }],
      placeholderPoNumber: 'IMPORT-TEST-0002',
    });
    const m = result.matrices[0]!;
    assert.equal(m.computedTotal, 16);
    assert.deepEqual(m.rows[0]!.cells, { S: 8, M: 8 });
    assert.equal(result.fields.poNumber, 'IMPORT-TEST-0002');
  });
});
