/**
 * Recovering a table from glyph positions.
 *
 * A PDF has no rows and no columns, only text at coordinates, so the whole
 * question is whether the grid can be rebuilt from geometry. These tests work
 * on synthesised positions rather than a real file: the arithmetic is the part
 * that can be wrong, and a fixture PDF would test pdf.js rather than this.
 *
 * The scan case is here because it is the one failure a user will actually hit,
 * and because an empty extraction and an unreadable document must not look the
 * same from the outside.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { groupIntoRows, rowToCells, findHeaderRow, extractFromPdf } from './pdf-extractor.js';

const at = (text: string, x: number, y: number, width = text.length * 5) => ({ text, x, y, width });

describe('recovering rows from glyph positions', () => {
  test('glyphs sharing a baseline become one row', () => {
    const rows = groupIntoRows([at('Color', 50, 700), at('Size', 200, 700), at('Qty', 320, 700)]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.map((i) => i.text), ['Color', 'Size', 'Qty']);
  });

  test('rows come back in reading order, not PDF order', () => {
    // PDF y counts up from the bottom of the page, so the largest y is the top
    // line — the reverse of how the page reads.
    const rows = groupIntoRows([at('second', 50, 680), at('first', 50, 700), at('third', 50, 660)]);
    assert.deepEqual(rows.map((r) => r[0]!.text), ['first', 'second', 'third']);
  });

  test('a baseline off by a point or two is still the same line', () => {
    // Real files are not pixel-perfect; 2pt is well inside one line's leading.
    const rows = groupIntoRows([at('Color', 50, 700), at('Size', 200, 698)]);
    assert.equal(rows.length, 1);
  });

  test('a genuine next line is not merged into the previous one', () => {
    const rows = groupIntoRows([at('Color', 50, 700), at('Red', 50, 685)]);
    assert.equal(rows.length, 2);
  });
});

describe('splitting a line into cells', () => {
  test('a wide gap is a column boundary', () => {
    assert.deepEqual(
      rowToCells([at('Red', 50, 700, 20), at('Small', 200, 700, 30), at('120', 320, 700, 15)]),
      ['Red', 'Small', '120'],
    );
  });

  test('a word space is not a column boundary', () => {
    // "Navy Blue" is one colour, not two cells — the distinction the whole
    // extraction rests on.
    assert.deepEqual(
      rowToCells([at('Navy', 50, 700, 22), at('Blue', 75, 700, 20), at('100', 300, 700, 15)]),
      ['Navy Blue', '100'],
    );
  });

  test('a single cell survives intact', () => {
    assert.deepEqual(rowToCells([at('PO 12345', 50, 700, 40)]), ['PO 12345']);
  });
});

describe('finding the table in a page of other things', () => {
  test('a letterhead above the table is skipped', () => {
    const rows = [
      ['ACME Garments Ltd'],
      ['12 Factory Road, Cairo'],
      ['Colour', 'Size', 'Quantity'],
      ['Red', 'S', '100'],
    ];
    const header = findHeaderRow(rows);
    assert.equal(header?.index, 2, 'should pick the headings, not the address');
  });

  test('a page with no table is reported as none rather than guessed at', () => {
    assert.equal(findHeaderRow([['Dear Sir'], ['Please find attached']]), null);
  });
});

describe('extraction as a whole', () => {
  test('a scan is named as a scan, not returned as an empty order', () => {
    // The failure a user will actually hit. "No orders found" would send
    // somebody looking for the problem in the wrong place.
    return extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{ pageNumber: 1, items: [] }],
    }).then((result) => {
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0]!.level, 'ERROR');
      assert.match(result.issues[0]!.message, /scan or a photograph/);
      // Names OCR as the missing capability rather than implying the file is bad.
      assert.match(result.issues[0]!.message, /OCR/);
      assert.match(result.issues[0]!.message, /Nothing was imported/);
      assert.equal(result.confidence, 0);
    });
  });

  test('a readable table produces the same result shape the Excel path does', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: [
          at('Colour', 50, 700, 30), at('Size', 200, 700, 20), at('Quantity', 320, 700, 40),
          at('Red', 50, 685, 20), at('S', 200, 685, 8), at('100', 320, 685, 18),
        ],
      }],
    });
    assert.equal(result.profileKey, 'pdf');
    assert.ok(result.mappings.length >= 3);
    // Never HIGH: a PDF's grid is inferred, so the review screen always asks.
    for (const m of result.mappings) assert.notEqual(m.confidence, 'HIGH');
    // The contract the whole pipeline depends on.
    for (const key of ['matrices', 'bom', 'lays', 'externalColors', 'issues'] as const) {
      assert.ok(key in result, `ExtractionResult must carry ${key}`);
    }
  });
});

/**
 * Reading the rows, not just recognising the columns.
 *
 * The first version of this extractor found the header, scored the columns and
 * returned none of the data — an extraction that reported what it *could* read
 * and then didn't. These tests exist so that cannot come back.
 */
describe('reading the data out of a PDF', () => {
  const row = (y: number, cells: Array<[number, string]>) =>
    cells.map(([x, text]) => at(text, x, y, text.length * 5));

  test('a colour/size/quantity table becomes a matrix', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: [
          ...row(700, [[50, 'Colour'], [200, 'Size'], [340, 'Quantity']]),
          ...row(680, [[50, 'Red'], [200, 'S'], [340, '420']]),
          ...row(660, [[50, 'Red'], [200, 'M'], [340, '610']]),
          ...row(640, [[50, 'Navy'], [200, 'S'], [340, '150']]),
        ],
      }],
    });
    assert.equal(result.matrices.length, 1);
    const m = result.matrices[0]!;
    assert.equal(m.ledger, 'ORDER');
    assert.deepEqual(m.sizes, ['S', 'M']);
    assert.equal(m.rows.length, 2);                       // Red and Navy
    assert.equal(m.rows.find((r) => r.color === 'Red')!.cells.M, 610);
    assert.equal(m.computedTotal, 1180);                  // 420 + 610 + 150
  });

  test('the column order does not matter', async () => {
    // Quantity first, then colour, then size — and different words for each.
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: [
          ...row(700, [[50, 'Pieces'], [180, 'Shade'], [320, 'Sz']]),
          ...row(680, [[50, '300'], [180, 'Sky Blue'], [320, 'XL']]),
          ...row(660, [[50, '275'], [180, 'Scarlet'], [320, 'M']]),
        ],
      }],
    });
    assert.equal(result.matrices[0]?.rows.length, 2);
    assert.equal(result.matrices[0]!.computedTotal, 575);
  });

  test('label-and-value lines above the table are read as fields', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: [
          ...row(760, [[50, 'PO Number:'], [220, 'HM-2026-8841']]),
          ...row(740, [[50, 'Customer:'], [220, 'Hummel A/S']]),
          ...row(700, [[50, 'Colour'], [200, 'Size'], [340, 'Quantity']]),
          ...row(680, [[50, 'Red'], [200, 'S'], [340, '10']]),
        ],
      }],
    });
    assert.equal(result.fields.PO_NUMBER, 'HM-2026-8841');
    assert.equal(result.fields.CLIENT, 'Hummel A/S');
  });

  test('rows with no quantity are skipped rather than imported as zero', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: [
          ...row(700, [[50, 'Colour'], [200, 'Size'], [340, 'Quantity']]),
          ...row(680, [[50, 'Red'], [200, 'S'], [340, '0']]),
          ...row(660, [[50, 'Red'], [200, 'M'], [340, 'TBC']]),
          ...row(640, [[50, 'Red'], [200, 'L'], [340, '90']]),
        ],
      }],
    });
    assert.equal(result.matrices[0]!.computedTotal, 90);
  });

  test('a table whose rows cannot be read says so rather than reporting success', async () => {
    const result = await extractFromPdf(Buffer.alloc(0), {
      reader: async () => [{
        pageNumber: 1,
        items: row(700, [[50, 'Colour'], [200, 'Size'], [340, 'Quantity']]),
      }],
    });
    assert.equal(result.matrices.length, 0);
    assert.ok(result.issues.some((i) => /no rows could be read/i.test(i.message)));
  });
});
