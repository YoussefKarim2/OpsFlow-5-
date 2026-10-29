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

/**
 * "laying tranmmere.xlsx": the body fabric planned in per-colour tables to
 * the right of the lay table — pieces with EFF / LENGHT / RATE above, LAYER,
 * METER — a working copy of them further right, the fabric in tables laid
 * out like the bill of materials, Cut Notes and a Fabric Date to External.
 */
function tranmere(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Laying fabric instructions_Patr');
  const set = (addr: string, v: unknown) => { ws.getCell(addr).value = v as ExcelJS.CellValue; };
  set('Z2', 'Cut Notes :'); set('AB2', 'Use the short table');
  set('C7', 'Po No :'); set('D7', '89-84873'); set('L7', 'Fabric 1'); set('O7', 'Tranmmere'); set('R7', 'Fabric 4'); set('U7', NO_RESULT);
  set('C8', 'Order Name :'); set('D8', 'Tranmmere'); set('L8', 'Fabric 2'); set('O8', NO_RESULT); set('R8', 'Fabric 5'); set('U8', NO_RESULT);
  set('F9', 'Cut Percentage'); set('G9', 0.05); set('Z9', 'Fabric Date to External :'); set('AC9', new Date(Date.UTC(2026, 9, 21)));
  // The lay table: header row 11, Ratio/Qty, one collar lay, TOTAL.
  ['fabric', 'Color', 'PANAL', 'SIZE', 'YXS', 'YS', 'Total', 'Layers', 'Total Length', 'NEST', 'Marker Length', 'EFF%', 'MAXLAYER']
    .forEach((h, i) => set(`${col(3 + i)}11`, h));
  set('F12', 'Ratio / Qty'); set('G12', 94); set('H12', 76); set('I12', 170);
  set('C13', 'Rib 37'); set('D13', 'Black'); set('E13', 'Collar'); set('F13', '(YXS)4, (YS)3'); set('G13', 104); set('H13', 78); set('I13', 182);
  set('J13', 26); set('K13', 14); set('L13', 17); set('M13', 0.5); set('N13', 0.81); set('O13', 1);
  set('F14', 'TOTAL'); set('G14', 104); set('H14', 78); set('I14', 182); set('J14', 26); set('K14', 14);
  set('C16', 'Approved'); set('C17', 'A.S');
  // The colour tables, block 1 at AE and a working copy at AZ.
  const block = (c0: number, rows: Array<[string, number | null, number | null]>, layers: boolean) => {
    const c = (n: number) => col(c0 + n);
    set(`${c(1)}8`, 'EFF'); set(`${c(3)}8`, 0.83); set(`${c(4)}8`, 0.77);
    set(`${c(1)}9`, 'LENGHT'); set(`${c(3)}9`, 1.24); set(`${c(4)}9`, 1.57);
    set(`${c(1)}10`, 'RATE'); set(`${c(3)}10`, 3); set(`${c(4)}10`, 3);
    set(`${c(0)}11`, 'fabric'); set(`${c(1)}11`, layers ? 'ItemsColor' : NO_RESULT); set(`${c(2)}11`, 'PANAL'); set(`${c(3)}11`, 'YXS'); set(`${c(4)}11`, 'YS'); set(`${c(5)}11`, 'Total');
    rows.forEach(([colour, yxs, ys], i) => {
      const r = 12 + i;
      set(`${c(0)}${r}`, 'Tranmmere'); set(`${c(1)}${r}`, colour); set(`${c(2)}${r}`, 'ALL');
      if (yxs != null) set(`${c(3)}${r}`, yxs); if (ys != null) set(`${c(4)}${r}`, ys);
      set(`${c(5)}${r}`, (yxs ?? 0) + (ys ?? 0));
    });
    if (layers) {
      set(`${c(1)}15`, 'Totals'); set(`${c(3)}15`, 241); set(`${c(4)}15`, 266); set(`${c(5)}15`, 507);
      set(`${c(0)}18`, 'LAYER');
      set(`${c(0)}19`, 'fabric'); set(`${c(1)}19`, 'Color'); set(`${c(2)}19`, 'PANAL'); set(`${c(3)}19`, 'YXS'); set(`${c(4)}19`, 'YS'); set(`${c(5)}19`, 'Total');
      set(`${c(0)}20`, 'Tranmmere'); set(`${c(1)}20`, 'COLUMBIA/WH'); set(`${c(2)}20`, 'ALL'); set(`${c(3)}20`, 51); set(`${c(4)}20`, 9); set(`${c(5)}20`, 60);
      set(`${c(0)}21`, 'Tranmmere'); set(`${c(1)}21`, 'HUNTER/WHT'); set(`${c(2)}21`, 'ALL'); set(`${c(3)}21`, 38); set(`${c(4)}21`, 51); set(`${c(5)}21`, 89);
      set(`${c(0)}22`, 'Tranmmere'); set(`${c(1)}22`, 'SILVER/BLACK'); set(`${c(2)}22`, 'ALL'); set(`${c(5)}22`, NO_RESULT);
      set(`${c(1)}23`, 'Totals'); set(`${c(3)}23`, 89); set(`${c(4)}23`, 60);
      set(`${c(0)}25`, 'METER');
      set(`${c(0)}26`, 'fabric'); set(`${c(1)}26`, 'Color'); set(`${c(2)}26`, 'PANAL'); set(`${c(3)}26`, 'YXS'); set(`${c(4)}26`, 'YS'); set(`${c(5)}26`, 'Total');
      set(`${c(0)}27`, 'Tranmmere'); set(`${c(1)}27`, 'COLUMBIA/WH'); set(`${c(2)}27`, 'ALL'); set(`${c(3)}27`, 64); set(`${c(4)}27`, 18); set(`${c(5)}27`, 82);
      set(`${c(0)}28`, 'Tranmmere'); set(`${c(1)}28`, 'HUNTER/WHT'); set(`${c(2)}28`, 'ALL'); set(`${c(3)}28`, 48); set(`${c(4)}28`, 81); set(`${c(5)}28`, 129);
      set(`${c(0)}29`, 'Tranmmere'); set(`${c(1)}29`, 'SILVER/BLACK'); set(`${c(2)}29`, 'ALL'); set(`${c(5)}29`, NO_RESULT);
      set(`${c(1)}30`, 'Totals'); set(`${c(3)}30`, 112); set(`${c(4)}30`, 99); set(`${c(5)}30`, 211);
    }
  };
  block(31, [['COLUMBIA/WH', 152, 26], ['HUNTER/WHT', 114, 152], ['SILVER/BLACK', 69, null]], true);
  block(52, [['COLUMBIA/WH', -5, null], ['SILVER/BLACK', 69, null]], false);
  // Fabric tables in the bill-of-materials layout: the collar's bottom left, the body's under each block.
  const fabricTable = (c0: number, r0: number, rows: Array<[string, string, number]>) => {
    ['Item Sort / Dep.', 'Item', 'Description', 'Color', 'Qty', 'Unit', 'Material issued', 'Shortage', 'Issued to'].forEach((h, i) => set(`${col(c0 + i)}${r0}`, h));
    rows.forEach(([item, colour, qty], i) => {
      const r = r0 + 1 + i;
      set(`${col(c0)}${r}`, 'FABRIC'); set(`${col(c0 + 1)}${r}`, item); set(`${col(c0 + 2)}${r}`, item === 'Rib 37' ? 'Collar' : 'ALL');
      set(`${col(c0 + 3)}${r}`, colour); set(`${col(c0 + 4)}${r}`, qty); set(`${col(c0 + 5)}${r}`, 'MET.'); set(`${col(c0 + 8)}${r}`, 'CUT');
    });
  };
  fabricTable(3, 40, [['Rib 37', 'Black', 14]]);
  fabricTable(31, 40, [['Tranmmere', 'COLUMBIA/WH', 82], ['Tranmmere', 'HUNTER/WHT', 129], ['Tranmmere', 'SILVER/BLACK', 29]]);
  fabricTable(52, 40, [['Tranmmere', 'SILVER/BLACK', 29]]);
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

  test('the Tranmere layout: colour tables, fabric tables, cut notes and the fabric date', async () => {
    const wb = tranmere();
    const r = readAgeLayingSheet(wb.worksheets[0]!)!;
    assert.equal(r.header.poNumber, '89-84873');
    // "Fabric 2" is blank; the "Fabric 5" label beyond it is not a fabric.
    assert.deepEqual(r.header.fabrics, ['Tranmmere']);
    assert.equal(r.header.fabricDateToExternal, '2026-10-21');
    assert.equal(r.header.cutNotes, 'Use the short table');
    assert.equal(r.lays.length, 1);
    assert.deepEqual(r.colourTables.map((t) => [t.block, t.kind, t.rows.length]), [[1, 'PIECES', 3], [2, 'PIECES', 2], [1, 'LAYERS', 3], [1, 'METERS', 3]]);
    assert.deepEqual(r.colourTables[0]!.params, { eff: { YXS: 0.83, YS: 0.77 }, markerLengthM: { YXS: 1.24, YS: 1.57 }, rate: { YXS: 3, YS: 3 } });
    assert.equal(r.colourTables[0]!.totals?.total, 507);
    assert.equal(r.fabricLines.length, 5);
    // The fabric tables stand in for the FABRIC / COLOR / METER summary; the working copy's repeat is read once.
    assert.deepEqual(r.fabricSummary.map((f) => [f.fabric, f.color, f.meters, f.issuedTo]), [
      ['Rib 37', 'Black', 14, 'CUT'], ['Tranmmere', 'COLUMBIA/WH', 82, 'CUT'], ['Tranmmere', 'HUNTER/WHT', 129, 'CUT'], ['Tranmmere', 'SILVER/BLACK', 29, 'CUT'],
    ]);

    const x = await extractLayingMarking(Buffer.from(await wb.xlsx.writeBuffer()));
    const lays = x.rows.filter((row) => row.kind === 'LAY');
    // One collar lay, then one lay per colour and size with pieces: COLUMBIA 2, HUNTER 2, SILVER 1 — the repeat is not a second plan.
    assert.deepEqual(lays.map((l) => [l.fabricName, l.fabricColor, l.sizeRatio, l.layers, l.markerLengthM, l.totalLengthM, l.efficiencyPct]), [
      ['Rib 37', 'Black', '(YXS)4, (YS)3', 26, 0.5, 14, 0.81],
      ['Tranmmere', 'COLUMBIA/WH', '(YXS3)', 51, 1.24, 64, 0.83],
      ['Tranmmere', 'COLUMBIA/WH', '(YS3)', 9, 1.57, 18, 0.77],
      ['Tranmmere', 'HUNTER/WHT', '(YXS3)', 38, 1.24, 48, 0.83],
      ['Tranmmere', 'HUNTER/WHT', '(YS3)', 51, 1.57, 81, 0.77],
      // No LAYER or METER figure for this one: layers from pieces ÷ rate, meters from layers × marker length.
      ['Tranmmere', 'SILVER/BLACK', '(YXS3)', 23, 1.24, 29, 0.83],
    ]);
    assert.ok(x.issues.some((i) => /5 lays by colour and size/.test(i.message)), x.issues.map((i) => i.message).join('\n'));
    assert.ok(x.issues.some((i) => /repeats 1 colour row/.test(i.message)));
    assert.equal(x.extras?.fabricSummary.length, 4);
  });

  test('a size with pieces but no rate and no layer count is warned about, not invented', async () => {
    const wb = tranmere();
    const ws = wb.worksheets[0]!;
    // Block 1: no RATE for YS, and 40 YS pieces for SILVER/BLACK, which the LAYER table leaves blank.
    ws.getCell('AI10').value = null;
    ws.getCell('AI14').value = 40;
    const x = await extractLayingMarking(Buffer.from(await wb.xlsx.writeBuffer()));
    const lays = x.rows.filter((row) => row.kind === 'LAY');
    // COLUMBIA and HUNTER YS still come from the LAYER table (26 pcs over 9 layers → 3 per layer); SILVER YS is left out.
    assert.deepEqual(lays.map((l) => [l.fabricColor, l.sizeRatio, l.layers]), [
      ['Black', '(YXS)4, (YS)3', 26],
      ['COLUMBIA/WH', '(YXS3)', 51], ['COLUMBIA/WH', '(YS3)', 9],
      ['HUNTER/WHT', '(YXS3)', 38], ['HUNTER/WHT', '(YS3)', 51],
      ['SILVER/BLACK', '(YXS3)', 23],
    ]);
    assert.ok(x.issues.some((i) => i.level === 'WARNING' && /No pieces-per-layer rate and no layer count for SILVER\/BLACK YS \(40 pcs\)/.test(i.message)), x.issues.map((i) => i.message).join('\n'));
  });

  test('an edited working copy is read once and warned about; a typed date is read day-first', async () => {
    const wb = tranmere();
    const ws = wb.worksheets[0]!;
    ws.getCell('BD12').value = 150; // the copy's COLUMBIA/WH YXS differs from 152
    ws.getCell('AC9').value = '21/10/2026';
    const x = await extractLayingMarking(Buffer.from(await wb.xlsx.writeBuffer()));
    const columbia = x.rows.filter((row) => row.kind === 'LAY' && row.fabricColor === 'COLUMBIA/WH');
    assert.equal(columbia.length, 2);
    assert.ok(x.issues.some((i) => i.level === 'WARNING' && /different figures for COLUMBIA\/WH; the first set is imported/.test(i.message)));
    assert.equal(x.extras?.header.fabricDateToExternal, '2026-10-21');
  });

  test('a cut table with no Totals row ends where the next table begins', () => {
    const wb = tranmere();
    const ws = wb.worksheets[0]!;
    ws.getCell('AF15').value = null; ws.getCell('AH15').value = null; ws.getCell('AI15').value = null; ws.getCell('AJ15').value = null;
    const r = readAgeLayingSheet(ws)!;
    const pieces = r.colourTables.find((t) => t.block === 1 && t.kind === 'PIECES')!;
    assert.deepEqual(pieces.rows.map((x) => x.colour), ['COLUMBIA/WH', 'HUNTER/WHT', 'SILVER/BLACK']);
    assert.equal(r.colourTables.filter((t) => t.block === 1).length, 3);
  });

  test('a sheet planned only in the cut tables, with an empty lay table, is still recognised', async () => {
    const wb = tranmere();
    const ws = wb.worksheets[0]!;
    for (const c of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O']) ws.getCell(`${c}13`).value = null;
    const x = await extractLayingMarking(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.equal(x.extras?.layout, 'AGE');
    assert.equal(x.rows.filter((row) => row.kind === 'LAY').length, 5);
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
