import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { readPackingDocument, cartonRange, matchColour, matchPackingToOrder } from './packing-reader.js';
import { sizeAliasFor } from './po-lines.js';

async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The factory template's Packing_Coordinator sheet: emoji navigation on the left, a title block, then C/No | Size | Qty | Color | Total | Gw | Nw. */
function factorySheet(wb: ExcelJS.Workbook) {
  wb.addWorksheet('Order Details_Coordinator').getCell('A1').value = 'Order details';
  const ws = wb.addWorksheet('Packing_Coordinator');
  const set = (a: string, v: unknown) => { ws.getCell(a).value = v as ExcelJS.CellValue; };
  set('A4', '🖼 Customer Reference'); set('A7', '🧾 Proforma Invoice'); set('A14', '📦 Packing');
  set('C5', 'Packing_Coordinator'); set('C6', 'Summer 26');
  set('C7', 'Po No :'); set('D7', '89-39'); set('I7', 'Required delivery date'); set('M7', new Date(Date.UTC(2026, 8, 3)));
  set('C8', 'Po Date'); set('D8', new Date(Date.UTC(2026, 7, 26))); set('I8', 'Promissed shipping date'); set('M8', new Date(Date.UTC(2026, 8, 3)));
  set('C9', 'Order Name :'); set('D9', 'inter shirt USA'); set('I9', 'Method of shipping:'); set('M9', 'Air');
  set('C12', 'Style No :'); set('D12', 1030);
  set('C14', 'Client :'); set('D14', 'Kittrich Xara division');
  set('C15', 'Shipping Adress'); set('D15', 'KITTRICH CORPORATION\n1585 WEST MISSION BLVD');
  set('C19', 'Billing Adress');
  set('C24', 'CartonQty');
  ['C/No', 'Size', 'Qty', 'Color', 'Total', 'Gw', 'Nw'].forEach((h, i) => set(`${'CDEFGHI'[i]}25`, h));
  const rows: Array<Array<unknown>> = [
    [1, 'S', 10, 'Navy', 30, 9.5, 8.2], [null, 'M', 10, null, null, null, null], [null, 'L', 10, null, null, null, null],
    [2, 'M', 30, 'Navy', 30, 9.6, 8.3], [3, 'XL', 25, 'Red', 25, 9.1, 8.0],
  ];
  rows.forEach((r, i) => r.forEach((v, k) => { if (v != null) set(`${'CDEFGHI'[k]}${26 + i}`, v); }));
  set('C32', 'Total'); set('E32', 85); set('H32', 28.2);
}

describe('the packing list reader', () => {
  test("the factory's sheet: details, mixed cartons one size per row, the TOTAL row", async () => {
    const r = await readPackingDocument(await xlsx(factorySheet), 'packing.xlsx');
    assert.equal(r.sheetName, 'Packing_Coordinator');
    assert.equal(r.table?.shape, 'ROW_PER_SIZE');
    assert.equal(r.table?.headerRow, 25);
    assert.deepEqual(r.table?.sizes, ['S', 'M', 'L', 'XL']);
    const d = Object.fromEntries(r.details.map((x) => [x.label, x.value]));
    assert.equal(d['Po No'], '89-39');
    assert.equal(d['Po Date'], '2026-08-26');
    assert.equal(d['Method of shipping'], 'Air');
    assert.equal(d['Style No'], '1030');
    assert.equal(d['Shipping Adress'], 'KITTRICH CORPORATION\n1585 WEST MISSION BLVD');
    // A label the sheet leaves blank is shown blank, not dropped.
    assert.equal(d['Billing Adress'], '');
    assert.ok(r.titles.includes('Summer 26'));
    assert.ok(!r.details.some((x) => /customer reference/i.test(x.label)), 'the navigation column is not content');

    assert.deepEqual(r.cartons.map((c) => [c.number, c.count, c.colour, c.bySize, c.perCarton, c.grossKg, c.netKg, c.sheetRow, c.lastRow]), [
      ['1', 1, 'Navy', { S: 10, M: 10, L: 10 }, 30, 9.5, 8.2, 26, 28],
      ['2', 1, 'Navy', { M: 30 }, 30, 9.6, 8.3, 29, 29],
      ['3', 1, 'Red', { XL: 25 }, 25, 9.1, 8.0, 30, 30],
    ]);
    assert.deepEqual(r.totals, { cartons: 3, pieces: 85, grossKg: 28.2, netKg: 24.5, bySize: { S: 10, M: 40, L: 10, XL: 25 }, byColour: { Navy: 60, Red: 25 } });
    assert.equal(r.printedTotals?.pieces, 85);
    assert.equal(r.printedTotals?.sheetRow, 32);
    assert.ok(!r.issues.some((i) => i.level === 'WARNING'), r.issues.map((i) => i.message).join('\n'));
    // The preview marks what was read.
    const kinds = Object.fromEntries(r.preview.rows.map((x) => [x.row, x.kind]));
    assert.equal(kinds[25], 'HEADER'); assert.equal(kinds[27], 'CARTON'); assert.equal(kinds[32], 'TOTAL'); assert.equal(kinds[7], 'DETAIL');
    assert.equal(r.preview.firstColumn, 3, 'the emoji column is left out of the preview');
  });

  test('a forwarder list: sizes across under a two-row header, carton ranges, per-carton weights', async () => {
    const buf = await xlsx((wb) => {
      const ws = wb.addWorksheet('PL');
      ws.getCell('A1').value = 'PACKING LIST';
      ws.getCell('A3').value = 'Invoice No:'; ws.getCell('B3').value = 'EXP-0110';
      ws.getCell('A4').value = 'PO No: 89-84873';
      ws.getCell('D4').value = 'Vessel:'; ws.getCell('E4').value = 'MSC ANNA';
      ws.getRow(7).values = ['Carton No', null, 'Ctns', 'Colour', 'Size', null, null, null, 'Pcs/Ctn', 'Total Pcs', 'N.W (kg)', 'G.W (kg)', 'Meas (cm)'];
      ws.mergeCells('A7:B7'); ws.mergeCells('E7:H7');
      ws.getRow(8).values = ['From', 'To', null, null, 'YXS', 'YS', 'M', 'L'];
      ws.getRow(9).values = [1, 10, 10, 'COLUMBIA/WH', 6, 6, 6, 6, 24, 240, 7.2, 8.0, '60x40x30'];
      ws.getRow(10).values = [11, 15, 5, 'HUNTER/WHT', 12, 12, null, null, 24, 120, 7.0, 7.8, '60x40x30'];
      ws.getRow(11).values = [16, 16, 1, 'SILVER/BLACK', null, null, 10, 6, 16, 16, 4.8, 5.4, '60x40x20'];
      ws.getRow(12).values = ['TOTAL', null, 16, null, null, null, null, null, null, 376, 111.8, 124.4];
    });
    const r = await readPackingDocument(buf, 'pl.xlsx');
    assert.equal(r.table?.shape, 'SIZES_ACROSS');
    assert.equal(r.table?.headerRow, 8);
    assert.deepEqual(r.table?.sizes, ['YXS', 'YS', 'M', 'L']);
    assert.deepEqual(r.details, [
      { label: 'Invoice No', value: 'EXP-0110' }, { label: 'PO No', value: '89-84873' }, { label: 'Vessel', value: 'MSC ANNA' },
    ]);
    assert.deepEqual(r.cartons.map((c) => [c.number, c.count, c.colour, c.perCarton, c.totalPieces, c.netKg, c.grossKg, c.measurement]), [
      ['1-10', 10, 'COLUMBIA/WH', 24, 240, 7.2, 8, '60x40x30'],
      ['11-15', 5, 'HUNTER/WHT', 24, 120, 7, 7.8, '60x40x30'],
      ['16', 1, 'SILVER/BLACK', 16, 16, 4.8, 5.4, '60x40x20'],
    ]);
    assert.deepEqual(r.totals.bySize, { YXS: 120, YS: 120, M: 70, L: 66 });
    assert.equal(r.totals.grossKg, 124.4);
    assert.equal(r.printedTotals?.cartons, 16);
    assert.deepEqual(r.issues, []);
  });

  test('a TOTAL row that disagrees with the cartons is said, and so is a repeated carton number', async () => {
    const buf = await xlsx((wb) => {
      const ws = wb.addWorksheet('PL');
      ws.addRow(['Ctn No', 'Colour', 'Size', 'Qty', 'G.W', 'N.W']);
      ws.addRow([1, 'Navy', 'M', 20, 6, 7]);
      ws.addRow([1, 'Navy', 'L', 20, 6, 5]);
      ws.addRow(['Total', null, null, 50]);
    });
    const r = await readPackingDocument(buf, 'pl.xlsx');
    const text = r.issues.map((i) => i.message).join('\n');
    assert.match(text, /TOTAL row says 50 pcs, but its cartons add up to 40/);
    assert.match(text, /Carton number 1 appears more than once/);
    assert.match(text, /Net weight is more than gross weight on carton 1/);
  });

  test('a CSV reads the same way', async () => {
    const csv = 'Packing list\nPO No:,13506\n\nCarton,Color,S,M,L,Total\n1-4,White,5,10,5,80\n5,White,,20,,20\nTotal,,,,,100\n';
    const r = await readPackingDocument(Buffer.from(csv), 'pl.csv');
    assert.equal(r.table?.shape, 'SIZES_ACROSS');
    assert.deepEqual(r.cartons.map((c) => [c.number, c.count, c.bySize, c.totalPieces]), [
      ['1-4', 4, { S: 5, M: 10, L: 5 }, 80],
      ['5', 1, { M: 20 }, 20],
    ]);
    assert.equal(r.totals.pieces, 100);
    assert.deepEqual(r.details, [{ label: 'PO No', value: '13506' }]);
  });

  test('a PDF with a text layer: the lines become rows, the table is read', async () => {
    // Positioned text as pdf.js gives it: y falls down the page.
    const line = (y: number, cells: Array<[number, string]>) => cells.map(([x, text]) => ({ text, x, y, width: text.length * 5 }));
    const items = [
      ...line(800, [[40, 'PACKING LIST']]),
      ...line(780, [[40, 'PO No: 72660']]),
      ...line(740, [[40, 'Ctn No'], [120, 'Colour'], [220, 'XS'], [270, 'S'], [320, 'M'], [380, 'Total'], [440, 'N.W'], [500, 'G.W']]),
      ...line(725, [[40, '1-3'], [120, 'Black'], [220, '4'], [270, '8'], [320, '8'], [380, '60'], [440, '6.5'], [500, '7.2']]),
      ...line(710, [[40, '4'], [120, 'Black'], [270, '10'], [320, '10'], [380, '20'], [440, '6.1'], [500, '6.9']]),
      ...line(695, [[40, 'Total'], [380, '80']]),
    ];
    const r = await readPackingDocument(Buffer.from('%PDF-1.4 fake'), 'pl.pdf', { pdfReader: async () => [{ pageNumber: 1, items }] });
    assert.equal(r.fileKind, 'pdf');
    assert.deepEqual(r.cartons.map((c) => [c.number, c.count, c.colour, c.bySize, c.totalPieces, c.netKg, c.grossKg]), [
      ['1-3', 3, 'Black', { XS: 4, S: 8, M: 8 }, 60, 6.5, 7.2],
      ['4', 1, 'Black', { S: 10, M: 10 }, 20, 6.1, 6.9],
    ]);
    assert.equal(r.printedTotals?.pieces, 80);
    assert.deepEqual(r.details, [{ label: 'PO No', value: '72660' }]);
  });

  test('a shipping summary by style: no carton numbers, the pieces and cartons of each line', async () => {
    const buf = await xlsx((wb) => {
      const ws = wb.addWorksheet('invoice');
      ws.addRow(['Qty', 'PO#', 'Description', 'G.W', 'N.W', 'No. Of Cartons', 'Unit', 'UNIT Price in $']);
      ws.addRow([1092, '89-84873', 'Tranmere Shirt', 120, 110, 10, 'pce', 3]);
      ws.addRow([306, '89-84874', 'Harrogate Shirt', 36, 33, 3, 'pce', 3]);
    });
    const r = await readPackingDocument(buf, 'pi.xlsx');
    assert.equal(r.table?.shape, 'ROW_PER_CARTON');
    assert.deepEqual(r.cartons.map((c) => [c.number, c.count, c.style, c.totalPieces]), [
      ['', 10, 'Tranmere Shirt', 1092], ['', 3, 'Harrogate Shirt', 306],
    ]);
    assert.equal(r.totals.cartons, 13);
    assert.equal(r.totals.pieces, 1398);
  });

  test('a data row that starts with a carton number is never taken for the heading', async () => {
    const buf = await xlsx((wb) => {
      const ws = wb.addWorksheet('x');
      ws.addRow(['Carton Barcode Product', 'Contents', 'Pieces Net', 'Gross']);
      ws.addRow([1, 'CTN-', 'SO-1', 'Cover × 40', 40, 24.8]);
    });
    const r = await readPackingDocument(buf, 'x.xlsx');
    assert.equal(r.table, null);
  });

  test('a file with no carton table is shown as it is, and says so', async () => {
    const buf = await xlsx((wb) => { const ws = wb.addWorksheet('Notes'); ws.addRow(['Shipped by air']); ws.addRow(['Thanks']); });
    const r = await readPackingDocument(buf, 'notes.xlsx');
    assert.equal(r.table, null);
    assert.equal(r.cartons.length, 0);
    assert.match(r.issues[0]!.message, /No carton table was found/);
    assert.equal(r.preview.rows.length, 2);
  });
});

describe('carton numbers and the order', () => {
  test('carton ranges as packing lists write them', () => {
    assert.deepEqual(cartonRange('1-10'), [1, 10]);
    assert.deepEqual(cartonRange('001 ~ 010'), [1, 10]);
    assert.deepEqual(cartonRange('11 to 15'), [11, 15]);
    assert.deepEqual(cartonRange('CTN-004'), [4, 4]);
    assert.deepEqual(cartonRange('7'), [7, 7]);
    assert.equal(cartonRange('10-1'), null);
    assert.equal(cartonRange('Mixed'), null);
  });

  test('colours match exactly, or by abbreviation when only one fits', () => {
    const order = ['Columbia/White', 'Hunter/White', 'Navy', 'Navy Blue'];
    assert.equal(matchColour('COLUMBIA/WH', order), 'Columbia/White');
    assert.equal(matchColour('hunter / wht', order), 'Hunter/White');
    assert.equal(matchColour('NAVY', order), 'Navy');
    assert.equal(matchColour('Red', order), null);
  });

  test("a whole buy's colours are \"STYLE — COLOUR\"; the style column tells apart a colour two styles share", () => {
    const order = ['TRANMERE SHIRT — COLUMBIA/WH', 'TRANMERE SHIRT — WHITE/WHITE', 'HARROGATE SHIRT — WHITE/WHITE'];
    assert.equal(matchColour('COLUMBIA/WH', order), 'TRANMERE SHIRT — COLUMBIA/WH');
    assert.equal(matchColour('Columbia/White', order), 'TRANMERE SHIRT — COLUMBIA/WH');
    assert.equal(matchColour('WHITE/WHITE', order), null, 'two styles have it, and nothing says which');
    assert.equal(matchColour('WHITE/WHITE', order, 'Harrogate Shirt'), 'HARROGATE SHIRT — WHITE/WHITE');
  });

  test('sizes go to the order names through the same alias the lay plan uses', () => {
    const m = matchPackingToOrder(
      { cartons: [{ colour: 'COLUMBIA/WH' }, { colour: 'Pink' }] as never, table: { sizes: ['YXS', 'YS', 'M', 'Adult Large'] } as never },
      { colours: ['Columbia/White'], sizes: ['Youth XS', 'Youth Small', 'Youth Medium', 'Adult Medium', 'Adult Large'] },
      sizeAliasFor,
    );
    assert.deepEqual(m.colours, { 'COLUMBIA/WH': 'Columbia/White', Pink: null });
    assert.deepEqual(m.cartonColours, ['Columbia/White', null]);
    assert.deepEqual(m.sizes, { YXS: 'Youth XS', YS: 'Youth Small', M: 'Adult Medium', 'Adult Large': 'Adult Large' });
  });
});
