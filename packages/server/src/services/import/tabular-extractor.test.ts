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
    const error = result.issues.find((i) => i.level === 'ERROR');
    assert.ok(error);
    assert.match(error!.message, /no table could be found/i);
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
    const error = result.issues.find((i) => i.level === 'ERROR' && i.field === ImportConcept.QUANTITY);
    assert.ok(error, 'the missing quantity column was not reported');
    assert.match(error!.message, /Quantity/);
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
