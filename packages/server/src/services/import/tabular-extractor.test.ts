/**
 * Universal importer tests — real workbooks, built in memory.
 *
 * §3 of the brief is a claim: *the system should not depend on one specific
 * Excel layout*. A claim like that is only worth anything if it is tested
 * against files that genuinely differ, so each case here constructs an actual
 * .xlsx with ExcelJS and runs the real extractor over it.
 *
 * The formats are the ones a garment factory actually receives: a clean long
 * table, the same data under a different customer's vocabulary, a size grid, a
 * file with a title block above the table, and a file with nothing usable in it
 * at all — which must fail clearly rather than import something wrong.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { ImportConcept } from '@opsflow/shared';
import { extractTabular, detectSizeColumns, readSheetTable } from './tabular-extractor.js';

// ─────────────────────────────────────────────────────────────────────────────
// Workbook builders
// ─────────────────────────────────────────────────────────────────────────────

async function buildWorkbook(
  sheets: Array<{ name: string; rows: unknown[][] }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const sheet = wb.addWorksheet(s.name);
    for (const row of s.rows) sheet.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Customer A: a clean long table. */
const CUSTOMER_A = [
  ['PO Number', 'Style', 'Color', 'Size', 'Qty'],
  ['PO-48291', 'ST-204', 'Sky Blue', 'S', 120],
  ['PO-48291', 'ST-204', 'Sky Blue', 'M', 180],
  ['PO-48291', 'ST-204', 'Sky Blue', 'L', 140],
  ['PO-48291', 'ST-204', 'Navy', 'S', 100],
  ['PO-48291', 'ST-204', 'Navy', 'M', 160],
  ['PO-48291', 'ST-204', 'Navy', 'L', 90],
];

/** Customer B: the same order, different words. */
const CUSTOMER_B = [
  ['Order No', 'Article', 'Shade', 'Size', 'Pieces'],
  ['PO-48291', 'ST-204', 'Sky Blue', 'S', 120],
  ['PO-48291', 'ST-204', 'Sky Blue', 'M', 180],
  ['PO-48291', 'ST-204', 'Sky Blue', 'L', 140],
  ['PO-48291', 'ST-204', 'Navy', 'S', 100],
  ['PO-48291', 'ST-204', 'Navy', 'M', 160],
  ['PO-48291', 'ST-204', 'Navy', 'L', 90],
];

/** Customer C: a size grid, which is how most factories actually write it. */
const CUSTOMER_C = [
  ['Colour', 'XS', 'S', 'M', 'L', 'XL'],
  ['Sky Blue', 40, 120, 180, 140, 60],
  ['Navy', 30, 100, 160, 90, 50],
  ['White', 20, 80, 110, 70, 40],
];

describe('Customer A — a clean long table', () => {
  test('every column is recognised and no confirmation is needed', async () => {
    const buffer = await buildWorkbook([{ name: 'Order', rows: CUSTOMER_A }]);
    const result = await extractTabular(buffer);

    assert.equal(result.analysis.layout, 'LONG');
    const concepts = result.analysis.columns.map((c) => c.concept);
    assert.deepEqual(concepts, [
      ImportConcept.PO_NUMBER, ImportConcept.STYLE, ImportConcept.COLOR,
      ImportConcept.SIZE, ImportConcept.QUANTITY,
    ]);
    assert.equal(result.analysis.readiness.ready, true);
  });

  test('the matrix is built with the right totals', async () => {
    const buffer = await buildWorkbook([{ name: 'Order', rows: CUSTOMER_A }]);
    const result = await extractTabular(buffer);

    const matrix = result.matrices.find((m) => m.ledger === 'ORDER')!;
    assert.equal(matrix.computedTotal, 790);
    assert.deepEqual(matrix.sizes, ['S', 'M', 'L']);
    assert.equal(matrix.rows.length, 2);
    assert.equal(matrix.rows.find((r) => r.color === 'Sky Blue')!.total, 440);
    assert.equal(matrix.rows.find((r) => r.color === 'Navy')!.total, 350);
  });

  test('scalars are lifted from the rows', async () => {
    const buffer = await buildWorkbook([{ name: 'Order', rows: CUSTOMER_A }]);
    const result = await extractTabular(buffer);
    assert.equal(result.fields.poNumber, 'PO-48291');
    assert.equal(result.fields.styleNumber, 'ST-204');
  });

  test('it can be committed — no blocking errors', async () => {
    const buffer = await buildWorkbook([{ name: 'Order', rows: CUSTOMER_A }]);
    const result = await extractTabular(buffer);
    assert.deepEqual(result.issues.filter((i) => i.level === 'ERROR'), []);
  });
});

describe('Customer B — the same order in a different vocabulary', () => {
  test('Article/Shade/Pieces resolve to Style/Colour/Quantity', async () => {
    const buffer = await buildWorkbook([{ name: 'Sheet1', rows: CUSTOMER_B }]);
    const result = await extractTabular(buffer);

    const byHeader = Object.fromEntries(result.analysis.columns.map((c) => [c.header, c.concept]));
    assert.equal(byHeader['Article'], ImportConcept.ARTICLE);
    assert.equal(byHeader['Shade'], ImportConcept.COLOR);
    assert.equal(byHeader['Pieces'], ImportConcept.QUANTITY);
    assert.equal(byHeader['Order No'], ImportConcept.PO_NUMBER);
  });

  test('it produces exactly the same matrix as Customer A', async () => {
    // The whole point of §3, asserted directly.
    const a = await extractTabular(await buildWorkbook([{ name: 'Order', rows: CUSTOMER_A }]));
    const b = await extractTabular(await buildWorkbook([{ name: 'Sheet1', rows: CUSTOMER_B }]));

    const ma = a.matrices[0]!;
    const mb = b.matrices[0]!;
    assert.equal(mb.computedTotal, ma.computedTotal);
    assert.deepEqual(mb.sizes, ma.sizes);
    assert.deepEqual(
      mb.rows.map((r) => [r.color, r.total]).sort(),
      ma.rows.map((r) => [r.color, r.total]).sort(),
    );
  });
});

describe('Customer C — a size grid', () => {
  test('the layout is detected from the data, not the sheet name', async () => {
    const buffer = await buildWorkbook([{ name: 'Sheet1', rows: CUSTOMER_C }]);
    const result = await extractTabular(buffer);

    assert.equal(result.analysis.layout, 'WIDE');
    assert.deepEqual(result.analysis.sizeColumns, ['XS', 'S', 'M', 'L', 'XL']);
  });

  test('one row per colour becomes one matrix row per colour', async () => {
    const buffer = await buildWorkbook([{ name: 'Sheet1', rows: CUSTOMER_C }]);
    const result = await extractTabular(buffer);

    const matrix = result.matrices[0]!;
    assert.equal(matrix.rows.length, 3);
    // 540 Sky Blue + 430 Navy + 320 White.
    assert.equal(matrix.computedTotal, 1290);
    assert.equal(matrix.rows.find((r) => r.color === 'Sky Blue')!.cells['M'], 180);
  });

  test('a missing Size column is not an error when the sizes are the headers', async () => {
    const buffer = await buildWorkbook([{ name: 'Sheet1', rows: CUSTOMER_C }]);
    const result = await extractTabular(buffer);
    const sizeErrors = result.issues.filter((i) => i.level === 'ERROR' && i.field === ImportConcept.SIZE);
    assert.deepEqual(sizeErrors, []);
  });

  test('the importer says how it read the file', async () => {
    // An automatic decision the coordinator cannot see is one they cannot trust.
    const buffer = await buildWorkbook([{ name: 'Sheet1', rows: CUSTOMER_C }]);
    const result = await extractTabular(buffer);
    const info = result.issues.find((i) => i.level === 'INFO' && /size grid/i.test(i.message));
    assert.ok(info, 'no explanation of the size-grid reading');
  });
});

describe('messy real-world files', () => {
  test('a title block above the table does not break header detection', async () => {
    const buffer = await buildWorkbook([{
      name: 'PO',
      rows: [
        ['ACME FASHION LTD'],
        [],
        ['Purchase Order', 'PO-99001'],
        ['Delivery Date', '2026-09-15'],
        [],
        ...CUSTOMER_A,
      ],
    }]);
    const result = await extractTabular(buffer);

    assert.equal(result.analysis.layout, 'LONG');
    assert.equal(result.matrices[0]!.computedTotal, 790);
  });

  test('scalars in the title block are read', async () => {
    const buffer = await buildWorkbook([{
      name: 'PO',
      rows: [
        ['ACME FASHION LTD'],
        ['Customer', 'ACME Fashion'],
        ['Delivery Date', new Date('2026-09-15')],
        [],
        ['Color', 'Size', 'Qty'],
        ['Navy', 'M', 100],
        ['Navy', 'L', 50],
      ],
    }]);
    const result = await extractTabular(buffer);
    assert.equal(result.fields.clientName, 'ACME Fashion');
    assert.ok(result.fields.requiredDeliveryDate instanceof Date);
  });

  test('a totals row is not imported as a colour', async () => {
    // Importing it would double the order.
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [...CUSTOMER_A, ['', '', 'TOTAL', '', 790]],
    }]);
    const result = await extractTabular(buffer);
    assert.equal(result.matrices[0]!.computedTotal, 790);
    assert.ok(!result.matrices[0]!.rows.some((r) => /total/i.test(r.color)));
  });

  test('blank rows inside the table do not end it', async () => {
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [
        ['Color', 'Size', 'Qty'],
        ['Navy', 'M', 100],
        [],
        ['Navy', 'L', 50],
        [],
        ['White', 'M', 25],
      ],
    }]);
    const result = await extractTabular(buffer);
    assert.equal(result.matrices[0]!.computedTotal, 175);
    assert.equal(result.matrices[0]!.rows.length, 2);
  });

  test('the same colour and size on two rows is summed, not overwritten', async () => {
    // A split delivery is two lines for one cell, and the customer means both.
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [
        ['Color', 'Size', 'Qty'],
        ['Navy', 'M', 100],
        ['Navy', 'M', 60],
      ],
    }]);
    const result = await extractTabular(buffer);
    assert.equal(result.matrices[0]!.rows[0]!.cells['M'], 160);
  });

  test('rows with no quantity are skipped and reported, not silently dropped', async () => {
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [
        ['Color', 'Size', 'Qty'],
        ['Navy', 'M', 100],
        ['Navy', 'L', null],
        ['', 'S', 40],
      ],
    }]);
    const result = await extractTabular(buffer);
    assert.equal(result.matrices[0]!.computedTotal, 100);
    const warning = result.issues.find((i) => i.level === 'WARNING' && /skipped/i.test(i.message));
    assert.ok(warning, 'skipped rows were not reported');
    assert.match(warning!.message, /2 rows were skipped/);
  });

  test('the order sheet wins over other tables in the same workbook', async () => {
    // Real workbooks carry price lists and instruction tabs alongside the order.
    // The one with colours, sizes and quantities has to win on content, not on
    // position or on being the biggest.
    const buffer = await buildWorkbook([
      { name: 'Instructions', rows: [
        ['Step', 'Owner', 'Due'],
        ['Confirm artwork', 'Sales', '2026-08-30'],
        ['Book freight', 'Logistics', '2026-09-10'],
      ] },
      { name: 'Prices', rows: [
        ['Item', 'Cost', 'Currency'],
        ['Tee', 4.2, 'USD'],
        ['Polo', 6.1, 'USD'],
      ] },
      { name: 'Detail', rows: CUSTOMER_A },
    ]);
    const result = await extractTabular(buffer);

    assert.equal(result.analysis.sheetName, 'Detail');
    assert.ok(
      result.analysis.candidateSheets.length >= 2,
      'the other tables should still be offered so a coordinator can switch',
    );
    const detail = result.analysis.candidateSheets.find((s) => s.name === 'Detail')!;
    const prices = result.analysis.candidateSheets.find((s) => s.name === 'Prices')!;
    assert.ok(detail.score > prices.score, 'the order sheet should score higher than the price list');
  });

  test('a two-column label block is never mistaken for a table', async () => {
    // "Purchase Order | PO-99001" over "Delivery Date | 2026-09-15" reads
    // exactly like a header row followed by data. An order needs three columns
    // at minimum, so two-column sheets cannot be order tables.
    const buffer = await buildWorkbook([{
      name: 'PO',
      rows: [
        ['Purchase Order', 'PO-99001'],
        ['Delivery Date', '2026-09-15'],
        ['Customer', 'ACME'],
        [],
        ...CUSTOMER_A,
      ],
    }]);
    const result = await extractTabular(buffer);
    assert.equal(result.analysis.headerRowIndex, 5);
    assert.equal(result.matrices[0]!.computedTotal, 790);
  });

  test('a different sheet can be chosen explicitly', async () => {
    const buffer = await buildWorkbook([
      { name: 'Detail', rows: CUSTOMER_A },
      { name: 'Grid', rows: CUSTOMER_C },
    ]);
    const result = await extractTabular(buffer, { sheetName: 'Grid' });
    assert.equal(result.analysis.sheetName, 'Grid');
    assert.equal(result.analysis.layout, 'WIDE');
  });
});

describe('when the file cannot be read', () => {
  test('a file with no table fails with an explanation, not a wrong import', async () => {
    const buffer = await buildWorkbook([{ name: 'Blank', rows: [['Just a note about the order']] }]);
    const result = await extractTabular(buffer);

    assert.deepEqual(result.matrices, []);
    const said = result.issues.find((i) => /no table could be found/i.test(i.message));
    assert.ok(said, 'the reader must say it found no table');
    assert.equal(said!.level, 'WARNING', 'and say it without blocking the import');
  });

  test('a table with no quantity column reports exactly what is missing', async () => {
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [
        ['Color', 'Size', 'Fabric'],
        ['Navy', 'M', 'Cotton'],
        ['Navy', 'L', 'Cotton'],
      ],
    }]);
    const result = await extractTabular(buffer);
    const said = result.issues.find((i) => i.field === ImportConcept.QUANTITY);
    assert.ok(said, 'the missing quantity column was not reported');
    assert.match(said!.message, /Quantity/);
    assert.equal(said!.level, 'WARNING', 'a missing column informs, it does not block');
  });

  test('a missing PO number is a warning the review screen can fix, not a hard failure', async () => {
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [['Color', 'Size', 'Qty'], ['Navy', 'M', 100]],
    }]);
    const result = await extractTabular(buffer);
    assert.ok(result.issues.some((i) => i.level === 'WARNING' && i.field === 'poNumber'));
    assert.deepEqual(result.issues.filter((i) => i.level === 'ERROR'), []);
  });
});

describe('coordinator corrections', () => {
  test('an override replaces the guess and is marked as manual', async () => {
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [
        ['Widget', 'Size', 'Qty'],
        ['Navy', 'M', 100],
        ['White', 'L', 50],
      ],
    }]);

    const before = await extractTabular(buffer);
    assert.equal(before.analysis.columns[0]!.concept, ImportConcept.IGNORE);
    assert.deepEqual(before.matrices, []);

    const after = await extractTabular(buffer, { overrides: { 0: ImportConcept.COLOR } });
    assert.equal(after.analysis.columns[0]!.concept, ImportConcept.COLOR);
    assert.equal(after.analysis.columns[0]!.source, 'MANUAL');
    assert.equal(after.matrices[0]!.computedTotal, 150);
  });

  test('a saved mapping is applied without asking', async () => {
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [['Widget', 'Size', 'Qty'], ['Navy', 'M', 100]],
    }]);
    const result = await extractTabular(buffer, {
      savedMapping: { widget: ImportConcept.COLOR },
    });
    assert.equal(result.analysis.columns[0]!.concept, ImportConcept.COLOR);
    assert.equal(result.analysis.columns[0]!.source, 'SAVED');
    assert.equal(result.analysis.columns[0]!.needsConfirmation, false);
  });

  test('a field typed on the review screen wins over the file', async () => {
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [['PO', 'Color', 'Size', 'Qty'], ['WRONG-1', 'Navy', 'M', 100]],
    }]);
    const result = await extractTabular(buffer, { fieldOverrides: { poNumber: 'PO-CORRECTED' } });
    assert.equal(result.fields.poNumber, 'PO-CORRECTED');
  });
});

describe('the analysis checklist', () => {
  test('reports what was found and in which column', async () => {
    const buffer = await buildWorkbook([{ name: 'Order', rows: CUSTOMER_A }]);
    const result = await extractTabular(buffer);
    const byConcept = Object.fromEntries(result.analysis.checklist.map((c) => [c.concept, c]));

    assert.equal(byConcept[ImportConcept.QUANTITY]!.detected, true);
    assert.equal(byConcept[ImportConcept.QUANTITY]!.columnHeader, 'Qty');
    assert.equal(byConcept[ImportConcept.COLOR]!.detected, true);
    assert.equal(byConcept[ImportConcept.MATERIAL]!.detected, false);
  });

  test('Article satisfies the Style row of the checklist', async () => {
    const buffer = await buildWorkbook([{ name: 'Order', rows: CUSTOMER_B }]);
    const result = await extractTabular(buffer);
    const style = result.analysis.checklist.find((c) => c.concept === ImportConcept.STYLE)!;
    assert.equal(style.detected, true);
    assert.equal(style.columnHeader, 'Article');
  });
});

describe('size-grid detection in isolation', () => {
  test('needs both size-like headers and numeric cells', async () => {
    const headers = ['Colour', 'XS', 'S', 'M', 'L'];
    const numeric = [['Navy', 10, 20, 30, 40]];
    const textual = [['Navy', 'no', 'no', 'no', 'no']];

    assert.equal(detectSizeColumns(headers, numeric).length, 4);
    assert.equal(detectSizeColumns(headers, textual).length, 0);
  });

  test('a lone size-like column is not a grid', async () => {
    // A column headed "L" holding numbers might be "Length".
    assert.equal(detectSizeColumns(['Colour', 'L', 'Notes'], [['Navy', 40, 'x']]).length, 0);
  });

  test('youth and extended sizes are recognised', async () => {
    const headers = ['Colour', 'YXS', 'YS', '2XL', '3XL'];
    const rows = [['Navy', 10, 20, 30, 40]];
    assert.equal(detectSizeColumns(headers, rows).length, 4);
  });
});

describe('header-row detection in isolation', () => {
  test('a numeric row is treated as data, never as headers', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('S');
    sheet.addRow([1, 2, 3, 4]);
    sheet.addRow(['Color', 'Size', 'Qty', 'Note']);
    sheet.addRow(['Navy', 'M', 100, 'x']);

    const table = readSheetTable(sheet)!;
    assert.equal(table.headerRowIndex, 2);
    assert.deepEqual(table.headers, ['Color', 'Size', 'Qty', 'Note']);
  });

  test('a sheet with headers but no data is not a table', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('S');
    sheet.addRow(['Color', 'Size', 'Qty']);
    assert.equal(readSheetTable(sheet), null);
  });
});

describe('reading the facts stated above the table', () => {
  test('a document title is not mistaken for the value below it', async () => {
    // "PURCHASE ORDER" scores as a PO-number heading, and the cell below it is
    // the *next* heading. The search-below rule read that caption as the
    // number, and the order was created as PO "PO Number:" — wrong in a way
    // that looks deliberate.
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [
        ['PURCHASE ORDER'],
        ['PO Number:', 'MEY-8817', '', 'Customer:', 'Meyba International'],
        [],
        ['Colour', 'S', 'M', 'L'],
        ['Navy', 100, 200, 150],
      ],
    }]);
    const r = await extractTabular(buffer);
    assert.equal(r.fields.poNumber, 'MEY-8817');
    assert.equal(r.fields.clientName, 'Meyba International');
  });

  test('a value that merely resembles a heading is still read', async () => {
    // The guard must reject captions, not plausible answers.
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [
        ['PO Number:', 'PO-1', '', 'Gender:', 'Mens'],
        [],
        ['Colour', 'S', 'M'],
        ['Navy', 10, 20],
      ],
    }]);
    const r = await extractTabular(buffer);
    assert.equal(r.fields.gender, 'Mens');
    assert.equal(r.fields.poNumber, 'PO-1');
  });

  test('the value to the right still wins over anything below', async () => {
    const buffer = await buildWorkbook([{
      name: 'Order',
      rows: [
        ['Season:', 'SS26'],
        ['Style:', 'UFEC01010'],
        [],
        ['Colour', 'S', 'M', 'L'],
        ['Navy', 10, 20, 30],
        ['White', 15, 25, 35],
      ],
    }]);
    const r = await extractTabular(buffer);
    assert.equal(r.fields.season, 'SS26');
    assert.equal(r.fields.styleNumber, 'UFEC01010');
  });
});

/**
 * A totals row is the grid restated, never a colour.
 *
 * The check looked only at column A. A customer table that starts in column B
 * has its "Total" label there, so the totals came through as one more colour
 * and the order was doubled.
 */
describe('totals rows away from column A', () => {
  test('a table that starts in column B stops at its Total row', async () => {
    const buffer = await buildWorkbook([{ name: 'Order', rows: [
      [null, 'Colour', 'S', 'M', 'L'],
      [null, 'Navy', 10, 20, 30],
      [null, 'Red', 5, 5, 5],
      [null, 'Total', 15, 25, 35],
    ] }]);
    const r = await extractTabular(buffer);
    const m = r.matrices[0]!;
    assert.deepEqual(m.rows.map((x) => x.color), ['Navy', 'Red']);
    assert.equal(m.computedTotal, 75);
  });

  test('a Total in the colour column is skipped even when another column comes first', async () => {
    const buffer = await buildWorkbook([{ name: 'Order', rows: [
      ['PO Number', 'Colour', 'S', 'M', 'L'],
      ['PO-1', 'Navy', 10, 20, 30],
      ['PO-1', 'Total', 10, 20, 30],
    ] }]);
    const r = await extractTabular(buffer);
    assert.deepEqual(r.matrices[0]!.rows.map((x) => x.color), ['Navy']);
    assert.equal(r.matrices[0]!.computedTotal, 60);
  });

  test('a column is placed on the header row it is really on', async () => {
    const buffer = await buildWorkbook([{ name: 'Order', rows: [
      ['PO Number', 'Colour', 'S', 'M'],
      ['PO-1', 'Navy', 10, 20],
    ] }]);
    const r = await extractTabular(buffer);
    assert.match(r.mappings[0]!.cell ?? '', /header row 1\)/);
  });
});

describe('a sheet written one block per style', () => {
  // Each block repeats the header and ends with its own total — one table in
  // three pieces. Read to the first total, it was one style of three.
  const BLOCKS = [
    ['Product Name', 'Color', 'Size', 'Qty'],
    ['Jersey - Strikers', 'SKY BLUE', 'YOUTH SMALL', 138],
    ['Jersey - Strikers', 'SKY BLUE', 'ADULT SMALL', 70],
    [null, null, 'TOTAL', 208],
    [],
    ['Product Name', 'Color', 'Size', 'Qty'],
    ['Jersey - Breakers', 'ATHLETIC GOLD', 'YOUTH SMALL', 114],
    [null, null, 'TOTAL', 114],
    [],
    ['Product Name', 'Color', 'Size', 'Qty'],
    ['Jersey - Wolves', 'SCARLET', 'YOUTH SMALL', 80],
    ['Jersey - Wolves', 'SCARLET', 'ADULT SMALL', 30],
    [null, null, 'TOTAL', 110],
  ];

  test('every block is read and no total is', async () => {
    const r = await extractTabular(await buildWorkbook([{ name: 'Sheet1', rows: BLOCKS }]));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.deepEqual(m.rows.map((row) => row.color), ['SKY BLUE', 'ATHLETIC GOLD', 'SCARLET']);
    assert.equal(m.computedTotal, 432);
  });

  test('a total that ends the only block still ends it', async () => {
    const r = await extractTabular(await buildWorkbook([{ name: 'Sheet1', rows: [...BLOCKS.slice(0, 4), [], ['Notes'], ['Deliver by sea']] }]));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.equal(m.computedTotal, 208);
  });
});

describe('a CSV saved with semicolons', () => {
  test('is read like one saved with commas', async () => {
    const r = await extractTabular(Buffer.from('PO Number;Colour;Size;Qty\nGEN-C1;Green;S;120\nGEN-C1;Green;M;240\n', 'utf8'));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.equal(m.computedTotal, 360);
    assert.equal(r.fields.poNumber, 'GEN-C1');
  });

  test('a tab-separated one too', async () => {
    const r = await extractTabular(Buffer.from('Colour\tSize\tQty\nRed\tS\t5\n', 'utf8'));
    assert.equal(r.matrices.find((x) => x.ledger === 'ORDER')!.computedTotal, 5);
  });

  test('a waist column is the sizes of a trouser order', async () => {
    const r = await extractTabular(await buildWorkbook([{ name: 'S', rows: [['PO', 'Colour', 'Waist', 'Pieces'], ['GEN-N1', 'Black', 32, 50], ['GEN-N1', 'Black', 28, 20], ['GEN-N1', 'Black', 30, 40]] }]));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.equal(m.computedTotal, 110);
    assert.deepEqual(m.sizes, ['28', '30', '32']);
  });
});

describe('workbooks from the third round of documents', () => {
  test('group headings above the sizes make "Youth S" and "Adult S" two sizes', async () => {
    const r = await extractTabular(await buildWorkbook([{ name: 'Order', rows: [
      ['PO Number:', 'MG-1'], [], ['', 'Youth', '', '', 'Adult', '', ''],
      ['Colour', 'S', 'M', 'L', 'S', 'M', 'L'], ['Navy', 10, 20, 30, 40, 50, 60],
    ] }]));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.deepEqual(m.sizes, ['Youth S', 'Youth M', 'Youth L', 'Adult S', 'Adult M', 'Adult L']);
    assert.equal(m.computedTotal, 210);
  });

  test('a bill of materials under the grid is not more colours', async () => {
    const r = await extractTabular(await buildWorkbook([{ name: 'Order', rows: [
      ['PO Number:', 'BB-6'], [], ['Colour', 'S', 'M', 'L'], ['Navy', 10, 20, 30], [], [],
      ['Bill of materials'], ['Item', 'Unit', 'Required'], ['Jersey fabric', 'MET', 120],
    ] }]));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.deepEqual(m.rows.map((row) => row.color), ['Navy']);
    assert.equal(m.computedTotal, 60);
  });

  test('Arabic headings are read', async () => {
    const r = await extractTabular(await buildWorkbook([{ name: 'طلب', rows: [
      ['رقم الطلب', 'اللون', 'المقاس', 'الكمية'], ['AR-7', 'كحلي', 'S', 40], ['AR-7', 'أحمر', 'M', 60],
    ] }]));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.equal(r.fields.poNumber, 'AR-7');
    assert.deepEqual(m.rows.map((row) => row.color), ['كحلي', 'أحمر']);
    assert.equal(m.computedTotal, 100);
  });

  test('a grid on its side in a workbook', async () => {
    const r = await extractTabular(await buildWorkbook([{ name: 'Order', rows: [
      ['PO Number:', 'TR-2'], [], ['Size', 'Navy', 'Red'], ['S', 100, 50], ['M', 150, 80], ['Total', 250, 130],
    ] }]));
    const m = r.matrices.find((x) => x.ledger === 'ORDER')!;
    assert.deepEqual(m.rows.map((row) => row.color), ['Navy', 'Red']);
    assert.equal(m.computedTotal, 380);
  });

  test('a sheet of 450 rows is read whole', async () => {
    const rows: unknown[][] = [['PO Number', 'Colour', 'Size', 'Qty']];
    for (let i = 1; i <= 450; i++) rows.push(['MR-5', `Colour ${i}`, 'M', 1]);
    const r = await extractTabular(await buildWorkbook([{ name: 'Order', rows }]));
    assert.equal(r.matrices.find((x) => x.ledger === 'ORDER')!.computedTotal, 450);
  });

  test('"275 pcs" in a cell is 275', async () => {
    const r = await extractTabular(await buildWorkbook([{ name: 'Order', rows: [['PO Number', 'Colour', 'Size', 'Pcs'], ['U-1', 'Navy', 'M', '275 pcs']] }]));
    assert.equal(r.matrices.find((x) => x.ledger === 'ORDER')!.computedTotal, 275);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A buyer's load-build template (Kittrich / Xara, "AGE Spring buy 2027")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The real file: 23 headings on row 1, one cell on row 2 (the vendor number),
 * then one row per SKU with the size inside the colour description and no PO
 * anywhere. Read as uploaded, the first item row became the header and the
 * order came out empty.
 */
const LOAD_BUILD_HEADERS = [
  'JDE PO', 'JDE Line', 'Load Build Request Date', 'Load Build #', 'Xara PO# or style #', 'Vendor',
  'Xara Part #', 'Style', 'Color description', 'Kittrich #', 'Qty', 'Unit Cost', 'Extended Cost',
  'Branch Location', 'Ship to Location', 'Leave Blank', 'Leave Blank', 'ETD', 'ETA', 'Original Qty',
  'Variance', 'PI Unit Cost', 'NOTES:',
];
const item = (part: string, style: string, desc: string, qty: number, cost: number) =>
  [null, null, null, null, null, null, part, style, desc, null, qty, cost];
const LOAD_BUILD = [
  LOAD_BUILD_HEADERS,
  [null, null, null, null, null, 39041],
  item('XRA-1003HW-YSM', 'TRANMERE SHIRT', 'HUNTER/WHT YOUTH SMALL', 144, 3),
  item('XRA-1003HW-YXSM', 'TRANMERE SHIRT', 'HUNTER/WHT YOUTH X-SMALL', 120, 3),
  item('XRA-1003LB-YLG', 'TRANMERE SHIRT', 'LIME/BLACK YOUTH LARGE', 72, 3),
  item('XRA-1003SB-ALG', 'TRANMERE SHIRT', 'SILVER/BLACK ADULT LARGE', 24, 3),
  item('XRA-1006NS-ALG', 'HARROGATE SHIRT', 'NAVY/RED ADULT LARGE', 24, 5),
  item('XRA-1006NS-AXL', 'HARROGATE SHIRT', 'NAVY/RED ADULT X-LARGE', 6, 5),
  item('XRA-1025NS-ALG', 'CHAMPION SERIES III', 'NAVY/RED ADULT LARGE', 12, 6),
  item('XRA-5020GP-ALG', 'SHUTOUT GK JERSEY GREY', 'ADULT LARGE', 24, 5.5),
  item('XRA-5020GP-AMD', 'SHUTOUT GK JERSEY GREY', 'ADULT MEDIUM', 12, 5.5),
  item('XRA-1030AE-YXSM', 'LEEDS JERSEY UNISEX PEACH', 'YOUTH EXTRA SMALL', 36, 4.17),
  item('XRA-1051CM-ADULT', 'TRAINING BIB', 'SKY ADULT', 240, 2.5),
  item('XRA-7030BL-OS', 'XARA BALL BAG', 'BLACK/WHITE ONE SIZE', 1000, 11.5),
];

describe('a buyer\'s load-build template', () => {
  test('the headings on row 1 are the header, not the first item row', async () => {
    const buffer = await buildWorkbook([{ name: 'Template', rows: LOAD_BUILD }]);
    const result = await extractTabular(buffer, { fileName: 'AGE.Spring buy 2027.xlsx' });
    assert.equal(result.analysis.headerRowIndex, 1);
    assert.equal(result.analysis.layout, 'LONG');
    assert.deepEqual(result.analysis.sizeColumns, [], 'no number under the items is a size column');
    const by = (c: ImportConcept) => result.analysis.columns.find((x) => x.concept === c)?.header;
    assert.equal(by(ImportConcept.COLOR), 'Color description');
    assert.equal(by(ImportConcept.QUANTITY), 'Qty');
    assert.equal(by(ImportConcept.STYLE), 'Style');
  });

  test('sizes come from the end of the colour text and colours are qualified by style', async () => {
    const buffer = await buildWorkbook([{ name: 'Template', rows: LOAD_BUILD }]);
    const result = await extractTabular(buffer, { fileName: 'AGE.Spring buy 2027.xlsx' });
    const m = result.matrices[0]!;
    assert.ok(m, 'a matrix was read');
    assert.equal(m.computedTotal, 144 + 120 + 72 + 24 + 24 + 6 + 12 + 24 + 12 + 36 + 240 + 1000, 'every row counted, including the bib and the bag');
    assert.deepEqual(m.sizes, ['Youth XS', 'Youth Small', 'Youth Large', 'Adult', 'Adult Medium', 'Adult Large', 'Adult XL', 'One Size'], 'wearing order, one-size goods last');
    assert.equal(m.rows.find((r) => r.color === 'LEEDS JERSEY UNISEX PEACH')!.cells['Youth XS'], 36, '"YOUTH EXTRA SMALL" is Youth XS of a style whose colour is in its name');
    assert.equal(m.rows.find((r) => r.color === 'TRAINING BIB — SKY')!.cells['Adult'], 240, 'a bib comes in Adult and nothing finer');
    const names = m.rows.map((r) => r.color);
    assert.ok(names.includes('TRANMERE SHIRT — HUNTER/WHT'));
    assert.ok(names.includes('HARROGATE SHIRT — NAVY/RED') && names.includes('CHAMPION SERIES III — NAVY/RED'), 'the same colour under two styles is two rows');
    assert.ok(names.includes('SHUTOUT GK JERSEY GREY'), 'a description that is only a size names the style');
    assert.ok(names.includes('XARA BALL BAG — BLACK/WHITE'));
    assert.equal(m.rows.find((r) => r.color === 'TRANMERE SHIRT — HUNTER/WHT')!.cells['Youth Small'], 144);
    assert.equal(m.rows.find((r) => r.color === 'SHUTOUT GK JERSEY GREY')!.cells['Adult Large'], 24);
    assert.equal(m.rows.find((r) => r.color === 'XARA BALL BAG — BLACK/WHITE')!.cells['One Size'], 1000);
    const said = result.issues.find((i) => i.level === 'INFO' && /read from the end of each colour description/i.test(i.message));
    assert.ok(said, 'the importer says how it read the sizes');
    assert.ok(!result.issues.some((i) => i.level === 'WARNING' && /identified as Size/i.test(i.message)), 'no complaint about a missing Size column');
  });

  test('with no PO and no description the order is named after the file', async () => {
    const buffer = await buildWorkbook([{ name: 'Template', rows: LOAD_BUILD }]);
    const result = await extractTabular(buffer, { fileName: 'AGE.Spring buy 2027.xlsx' });
    assert.equal(result.fields.orderName, 'AGE.Spring buy 2027');
    assert.ok(result.issues.some((i) => i.field === 'poNumber' && i.level === 'WARNING'), 'the missing PO is still reported');
  });

  test('a plain colour list with a Size column is not carved up', async () => {
    const buffer = await buildWorkbook([{ name: 'Order', rows: CUSTOMER_A }]);
    const result = await extractTabular(buffer);
    assert.deepEqual(result.matrices[0]!.rows.map((r) => r.color), ['Sky Blue', 'Navy']);
    assert.ok(!result.issues.some((i) => /colour description/i.test(i.message)));
  });

  test('colour text with no size at its end is left alone', async () => {
    const rows = [
      ['Style', 'Colour', 'Qty'],
      ['ST-1', 'Navy', 10],
      ['ST-1', 'Red', 12],
      ['ST-1', 'Pantone 186', 8],
    ];
    const buffer = await buildWorkbook([{ name: 'Order', rows }]);
    const result = await extractTabular(buffer);
    assert.equal(result.matrices.length, 0, 'no size anywhere means no matrix, not an invented one');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One table in pieces: blocks side by side, blocks shifted a column
// ─────────────────────────────────────────────────────────────────────────────

const FLORIDA_BLOCK = (name: string, colour: string, qty: number[], offset = 0) => {
  const pad = Array<null>(offset).fill(null);
  const sizes = ['YOUTH X-SMALL', 'YOUTH SMALL', 'YOUTH MEDIUM', 'ADULT SMALL'];
  return [
    [...pad, 'Product Name', 'Color', 'Size', 'Qty'],
    ...sizes.map((s, i) => [...pad, name, colour, s, qty[i]!]),
    [...pad, null, null, 'TOTAL', qty.reduce((a, b) => a + b, 0)],
  ];
};

describe('a customer order written as several blocks of the same table', () => {
  test('two blocks side by side on the same rows are both read', async () => {
    const left = FLORIDA_BLOCK('CREW NECK - STRIKERS', 'SKY BLUE', [50, 138, 141, 70]);
    const right = FLORIDA_BLOCK('CREW NECK - NIGHTHAWKS', 'LIME', [50, 138, 141, 50]);
    const rows = left.map((r, i) => [...r, null, ...(right[i] ?? [])]);
    const buffer = await buildWorkbook([{ name: 'Sheet1', rows }]);
    const result = await extractTabular(buffer);
    const m = result.matrices[0]!;
    assert.equal(m.computedTotal, 399 + 379);
    assert.deepEqual(m.rows.map((r) => [r.color, r.total]), [['SKY BLUE', 399], ['LIME', 379]]);
  });

  test('a later block pasted one column to the right is still this table', async () => {
    const rows = [
      ...FLORIDA_BLOCK('CREW NECK - STRIKERS', 'SKY BLUE', [50, 138, 141, 70]),
      [],
      ...FLORIDA_BLOCK('CREW NECK - NIGHTHAWKS', 'LIME', [50, 138, 141, 50], 1),
    ];
    const buffer = await buildWorkbook([{ name: 'Sheet1', rows }]);
    const result = await extractTabular(buffer);
    const m = result.matrices[0]!;
    assert.equal(m.computedTotal, 399 + 379);
    assert.equal(m.rows.length, 2);
    assert.ok(!m.rows.some((r) => /total/i.test(r.color)), 'neither block\'s total row is a colour');
  });

  test('blocks under each other with the same columns still read as one table', async () => {
    const rows = [
      ...FLORIDA_BLOCK('A', 'SKY BLUE', [1, 2, 3, 4]),
      [],
      ...FLORIDA_BLOCK('B', 'LIME', [5, 6, 7, 8]),
    ];
    const result = await extractTabular(await buildWorkbook([{ name: 'Sheet1', rows }]));
    assert.equal(result.matrices[0]!.computedTotal, 36);
  });
});

describe('a proforma invoice workbook', () => {
  test('is named for what it is, and its grid sheet is still read with adult and youth sizes', async () => {
    const invoice = [
      [], [], [], ['Protime Sports  Proforma invoice No. 18'], ['The goods stated on this invoice are duty free'],
      ['Shipment From', null, 'Egypt'], ['Date', null, 46238],
      ['Qty', 'PO#', 'Description', 'HTS Code', 'No. of Cartons', 'UNIT Price in $', 'Total Price in $'],
      [1972, 'A302059B', 'Florida T shirt', '610990', 18, 7, 13804],
    ];
    const grid = [
      ['Style', 'Florida T shirt', null, null, 'Style #', '3046', null, null, 'Total Qty', 1972],
      [], ['Date', 46238, null, null, 'PO #', 'A302059B'], [], [], [],
      ['Color/Size', 'YXXS', 'YXS', 'YS', 'YM', 'YL', 'AS', 'AM', 'AL', 'AXL', 'AXXL', 'AXXXL', 'TOTAL'],
      ['SKY BLUE', 20, 50, 138, 141, 90, 70, 35, 20, 10, 5, null, 579],
      ['LIME', 20, 50, 138, 141, 80, 50, 35, 15, 10, 5, null, 544],
      ['TOTAL', null, null, null, null, null, null, null, null, null, null, null, 1123],
    ];
    const buffer = await buildWorkbook([{ name: 'invoice', rows: invoice }, { name: 'A 302059B Florida T shirt', rows: grid }]);
    const result = await extractTabular(buffer);
    assert.ok(result.issues.some((i) => i.field === 'documentKind' && /proforma invoice/i.test(i.message)));
    const m = result.matrices[0]!;
    assert.equal(m.computedTotal, 1123, 'adult sizes AS…AXXL are sizes too');
    assert.deepEqual(m.sizes, ['YXXS', 'YXS', 'YS', 'YM', 'YL', 'AS', 'AM', 'AL', 'AXL', 'AXXL']);
  });
});
