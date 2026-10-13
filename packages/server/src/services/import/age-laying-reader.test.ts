/**
 * The factory's own laying sheet, read as it is laid out.
 *
 * The fixture reproduces "Florida layering.xlsx" cell for cell where it
 * matters: the title block with labels in merged cells, the lay table with
 * three broken size columns (#REF! and a formula with no cached result), the
 * Ratio/Qty row, the TOTAL and (+/-) rows, spare rows that carry only
 * formulas and a MAXLAYER of 1, the sign-off labels with the fabric summary
 * on the same rows, and the per-colour panel tables to the right.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { readAgeLayingSheet } from './age-laying-reader.js';
import { extractLayingMarking } from './laying-extractor.js';
import { readCsvWorkbook } from './open-workbook.js';

const SIZES = ['2YXS', 'YXS', 'YS', 'YM', 'YL', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const REF = { error: '#REF!' } as unknown as ExcelJS.CellValue;
const NO_RESULT = { formula: "'[1]Cut Order'!O20" } as unknown as ExcelJS.CellValue;

function florida(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const set = (addr: string, v: unknown) => { ws.getCell(addr).value = v as ExcelJS.CellValue; };
  set('B6', 'Summer 26');
  set('B7', 'Po No :'); set('C7', 13506); set('G7', 'Fabric 1'); set('J7', 'Rosetta'); set('M7', 'Spread Notes :'); set('P7', 'يوجد تكت جنب ستان');
  set('B8', 'Order Name :'); set('C8', 'Florida T shirt'); set('G8', 'Fabric 2'); set('J8', 0);
  set('B9', 'Item Type :'); set('C9', 'T-Shirt'); set('G9', 'Fabric 3'); set('J9', 0);
  set('B10', 'Gender :'); set('C10', 'Male'); set('G10', 'Fabric Description'); set('J10', 0);
  set('B11', 'Client :'); set('C11', 'ProTime '); set('G11', 'Cut Percentage'); set('J11', 0.05);
  // Header row 13: sizes F..P, then a formula without a result and three #REF! columns.
  const head = ['fabric', 'Color', 'PANAL', 'SIZE', ...SIZES];
  head.forEach((h, i) => set(`${col(2 + i)}13`, h));
  set('Q13', NO_RESULT); set('R13', REF); set('S13', REF); set('T13', REF);
  set('U13', 'Total'); set('V13', 'Layers'); set('W13', 'Total Length'); set('Y13', 'NEST'); set('Z13', 'Marker Length'); set('AA13', 'EFF%'); set('AB13', 'MAXLAYER');
  set('E14', 'Ratio / Qty'); [84, 206, 494, 503, 316, 191, 148, 74, 44, 24].forEach((q, i) => set(`${col(6 + i)}14`, q)); set('U14', 2084);
  const lays: Array<[string, Record<string, number>, number, number, number, number]> = [
    ['(YXS1), (YS1), (YM1), (YL1), (M1)', { YXS: 140, YS: 140, YM: 140, YL: 140, M: 140 }, 140, 391, 5, 2.61],
    ['(YS2), (YM2), (YL1)', { YS: 354, YM: 354, YL: 177 }, 177, 457, 5, 2.41],
    ['(2YXS1), (S3), (L1), (XL1)', { '2YXS': 44, S: 132, L: 44, XL: 44 }, 44, 196, 6, 4.15],
  ];
  lays.forEach(([ratio, by, layers, total, nest, marker], i) => {
    const r = 15 + i;
    set(`B${r}`, 'Rosetta'); set(`C${r}`, 'White'); set(`D${r}`, 'ALL'); set(`E${r}`, ratio);
    for (const [s, q] of Object.entries(by)) set(`${col(6 + SIZES.indexOf(s))}${r}`, q);
    set(`U${r}`, Object.values(by).reduce((a, b) => a + b, 0)); set(`V${r}`, layers); set(`W${r}`, total); set(`Y${r}`, nest); set(`Z${r}`, marker); set(`AB${r}`, 1);
  });
  // Spare rows: formulas with no result, MAXLAYER 1 — not lays.
  for (const r of [18, 19]) { set(`E${r}`, NO_RESULT); set(`U${r}`, NO_RESULT); set(`AB${r}`, 1); }
  set('E20', 'TOTAL'); set('F20', 44); set('G20', 140); set('H20', 494); set('U20', 1849); set('V20', 361); set('W20', 1044); set('Y20', 16); set('Z20', 9.17); set('AB20', 3);
  set('E21', '(+/-)'); set('F21', -40); set('U21', -235);
  // Sign-off lines, with the fabric summary on the same rows.
  set('B22', 'Cut By'); set('C22', 'Cut By'); set('N22', 'Numbring By'); set('Y22', 'FABRIC'); set('Z22', 'COLOR'); set('AA22', 'METER');
  set('B23', 'Inspected By'); set('E23', 'Tamer'); set('N23', 'Bundelled By'); set('Y23', 'Rosetta'); set('Z23', 'White'); set('AA23', 1044);
  set('B24', 'Approved'); set('B25', 'A.S');
  // Panel tables to the right.
  set('AD13', 'Florida T shirt');
  set('AD15', 'Color'); SIZES.forEach((s, i) => set(`${col(31 + i)}15`, s)); set('AP15', 'Total'); set('AQ15', 'PANAL');
  set('AD16', 'SKY BLUE'); set('AP16', { formula: 'SUM(AE16:AO16)', result: 0 });
  set('AD17', 'front'); set('AG17', 1); set('AJ17', 1); set('AP17', 2);
  set('AD18', 'back'); set('AF18', 3); set('AP18', 3);
  set('AD19', 'sl'); set('AF19', 2); set('AP19', 2);
  set('AD20', NO_RESULT);
  set('AD21', 'ATH. GOLD');
  set('AD22', 'front'); set('AG22', 6); set('AH22', 4); set('AP22', 10);
  set('AD23', 'Totals');
  set('AD26', 'collar-Florida T shirt');
  set('AD27', 'Color'); SIZES.forEach((s, i) => set(`${col(31 + i)}27`, s)); set('AP27', 'Total');
  set('AD28', 'SKY BLUE'); set('AD29', 'collar'); set('AL29', 6); set('AP29', 6);
  set('AD30', 'Totals');
  return wb;
}

/** 1 → A, 27 → AA. */
function col(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

describe('the factory laying sheet', () => {
  const r = readAgeLayingSheet(florida().worksheets[0]!)!;

  test('is recognised, with its sizes and nothing from the broken columns', () => {
    assert.equal(r.headerRow, 13);
    assert.deepEqual(r.sizes, SIZES);
  });
  test('the title block is read label by label', () => {
    assert.equal(r.header.poNumber, '13506');
    assert.equal(r.header.orderName, 'Florida T shirt');
    assert.equal(r.header.client, 'ProTime');
    assert.equal(r.header.season, 'Summer 26');
    assert.deepEqual(r.header.fabrics, ['Rosetta']);
    assert.equal(r.header.cutPercentage, 0.05);
    assert.equal(r.header.spreadNotes, 'يوجد تكت جنب ستان');
  });
  test('the Ratio/Qty row is the requirement per size', () => {
    assert.equal(r.requirement?.bySize.YS, 494);
    assert.equal(r.requirement?.total, 2084);
  });
  test('every lay, and only the lays', () => {
    assert.equal(r.lays.length, 3);
    assert.deepEqual(r.lays.map((l) => [l.sizeRatio, l.layers, l.markerLengthM, l.totalLengthM, l.nestPcs, l.maxLayer]), [
      ['(YXS1), (YS1), (YM1), (YL1), (M1)', 140, 2.61, 391, 5, 1],
      ['(YS2), (YM2), (YL1)', 177, 2.41, 457, 5, 1],
      ['(2YXS1), (S3), (L1), (XL1)', 44, 4.15, 196, 6, 1],
    ]);
    assert.deepEqual(r.lays[0]!.bySize, { YXS: 140, YS: 140, YM: 140, YL: 140, M: 140 });
  });
  test('the TOTAL and (+/-) rows', () => {
    assert.equal(r.totals?.total, 1849);
    assert.equal(r.totals?.layers, 361);
    assert.equal(r.totals?.totalLengthM, 1044);
    assert.equal(r.totals?.maxLayer, 3);
    assert.equal(r.variance?.bySize['2YXS'], -40);
    assert.equal(r.variance?.total, -235);
  });
  test('sign-off lines: beside the label, or beneath it, never the fabric summary', () => {
    assert.deepEqual(r.signatures, { cutBy: null, numberingBy: null, inspectedBy: 'Tamer', bundledBy: null, approvedBy: 'A.S' });
    assert.deepEqual(r.fabricSummary, [{ fabric: 'Rosetta', color: 'White', meters: 1044 }]);
  });
  test('the per-colour panel tables, titled, with their parts', () => {
    assert.equal(r.panelTables.length, 2);
    const [body, collar] = r.panelTables;
    assert.equal(body!.title, 'Florida T shirt');
    assert.deepEqual(body!.colours.map((c) => [c.colour, c.parts.map((p) => [p.part, p.total])]), [
      ['SKY BLUE', [['Front', 2], ['Back', 3], ['Sleeve', 2]]],
      ['ATH. GOLD', [['Front', 10]]],
    ]);
    assert.deepEqual(body!.colours[0]!.parts[0]!.bySize, { YS: 1, S: 1 });
    assert.equal(collar!.title, 'collar-Florida T shirt');
    assert.deepEqual(collar!.colours[0]!.parts[0], { part: 'Collar', bySize: { L: 6 }, total: 6 });
  });
});

describe('through the Laying & Marking extractor', () => {
  test('lays, panel rows, extras and the PO number', async () => {
    const buf = Buffer.from(await florida().xlsx.writeBuffer());
    const r = await extractLayingMarking(buf);
    assert.equal(r.analysis.readiness.ready, true, JSON.stringify(r.analysis.readiness));
    const lays = r.rows.filter((x) => x.kind === 'LAY');
    const panels = r.rows.filter((x) => x.kind === 'PANEL');
    assert.equal(lays.length, 3);
    assert.equal(panels.length, 5);
    assert.deepEqual(panels[0], {
      ...panels[0], fabricName: 'Rosetta', fabricColor: 'SKY BLUE', panel: 'Front', sizeRatio: '(YS1), (S1)', layers: 1, markerLengthM: null,
    });
    assert.deepEqual(r.detectedPoNumbers, ['13506']);
    assert.equal(r.extras?.layout, 'AGE');
    assert.equal(r.extras?.totals?.totalLengthM, 1044);
    assert.ok(r.issues.some((i) => i.level === 'INFO' && /Recognised the factory laying sheet: 3 lays, 5 panel rows/.test(i.message)), r.issues.map((i) => i.message).join('\n'));
    assert.ok(!r.issues.some((i) => i.level === 'WARNING'), r.issues.map((i) => i.message).join('\n'));
  });

  test('a TOTAL row that disagrees with the lays is reported', async () => {
    const wb = florida();
    wb.worksheets[0]!.getCell('U20').value = 1900;
    const r = await extractLayingMarking(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.ok(r.issues.some((i) => /TOTAL row says 1900 pieces, but its lays add up to 1849/.test(i.message)));
  });

  test('the same sheet pasted as a CSV reads the same', async () => {
    const csv = Buffer.from(await florida().csv.writeBuffer());
    const wb = await readCsvWorkbook(csv);
    const r = readAgeLayingSheet(wb.worksheets[0]!)!;
    assert.deepEqual(r.sizes, SIZES);
    assert.equal(r.lays.length, 3);
    assert.equal(r.header.poNumber, '13506');
    assert.equal(r.panelTables.length, 2);
  });

  test('a generic laying table still goes through the column reader', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Laying');
    ws.addRow(['Marker No', 'Fabric', 'Panel', 'Size Ratio', 'Layers', 'Marker Length']);
    ws.addRow(['M1', 'Rosetta', 'ALL', '(YXS1), (YS1)', 140, 2.61]);
    const r = await extractLayingMarking(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.equal(r.rows.length, 1);
    assert.equal(r.extras, undefined);
    assert.equal(r.rows[0]!.markerNumber, 'M1');
  });
});
