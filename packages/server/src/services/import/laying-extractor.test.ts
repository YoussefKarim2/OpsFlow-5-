import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { extractLayingMarking } from './laying-extractor.js';

/**
 * No two factories draw a laying sheet the same way.
 *
 * The headings differ, the column order differs, there is usually a title block
 * above the table, and a column the reader expects is often simply absent. None
 * of that is a fault in the file, so none of it may refuse the import: whatever
 * is understood gets read, the rest is assigned by hand or left out, and the
 * lay plan fills in with what was there.
 *
 * Each case below is a layout a real sheet could plausibly arrive in.
 */

async function sheet(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Laying');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const blocking = (r: { issues: Array<{ level: string }> }) =>
  r.issues.filter((i) => i.level === 'ERROR').length;

describe('reading a laying sheet, whatever shape it arrives in', () => {
  test('the headings the workbook itself uses', async () => {
    const r = await extractLayingMarking(await sheet([
      ['Marker No', 'Fabric', 'Panel', 'Size Ratio', 'Layers', 'Marker Length'],
      ['M1', 'Rosetta', 'ALL', '(YXS1), (YS1)', 140, 2.61],
      ['M2', 'Rosetta', 'ALL', '(YS2), (YM2)', 177, 2.41],
    ]));
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0]!.fabricName, 'Rosetta');
    assert.equal(r.rows[0]!.layers, 140);
    assert.equal(blocking(r), 0);
  });

  test('a sheet that says Material where the last one said Fabric', async () => {
    // Both already mean the same field on an order; the reader used to ignore
    // the column and report the fabric as empty on a sheet that stated it.
    const r = await extractLayingMarking(await sheet([
      ['Lay #', 'Material', 'Part', 'Ratio', 'Plies', 'Length (m)'],
      ['1', 'Rosetta', 'ALL', '(S3), (L1)', 44, 4.15],
    ]));
    assert.equal(r.rows[0]!.fabricName, 'Rosetta');
    assert.equal(r.rows[0]!.layers, 44);
    assert.equal(blocking(r), 0);
  });

  test('a title block above the table does not hide it', async () => {
    const r = await extractLayingMarking(await sheet([
      ['LAYING & MARKING SHEET'],
      ['PO A302059B', '', 'Date', '2026-09-13'],
      [],
      ['Marker No', 'Fabric', 'Panel', 'Size Ratio', 'Layers', 'Marker Length'],
      ['M1', 'Rosetta', 'ALL', '(YXS1)', 12, 2.40],
    ]));
    assert.equal(r.rows.length, 1);
    assert.equal(blocking(r), 0);
  });

  test('the columns can be in any order', async () => {
    const r = await extractLayingMarking(await sheet([
      ['Layers', 'Marker Length', 'Fabric', 'Size Ratio', 'Marker No'],
      [140, 2.61, 'Rosetta', '(YM1)', 'M1'],
    ]));
    assert.equal(r.rows[0]!.fabricName, 'Rosetta');
    assert.equal(r.rows[0]!.markerLengthM, 2.61);
    assert.equal(blocking(r), 0);
  });

  test('a missing column is imported without, not refused', async () => {
    // No marker length anywhere. The committer defaults it; the lay is real.
    const r = await extractLayingMarking(await sheet([
      ['Marker No', 'Fabric', 'Size Ratio', 'Layers'],
      ['M1', 'Rosetta', '(YXS1), (YS1)', 140],
    ]));
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.markerLengthM, null);
    assert.equal(blocking(r), 0, 'a column the sheet does not have must not block the import');
  });

  test('blank rows and a totals row do not become lays', async () => {
    const r = await extractLayingMarking(await sheet([
      ['Marker No', 'Fabric', 'Panel', 'Size Ratio', 'Layers', 'Marker Length'],
      ['M1', 'Rosetta', 'ALL', '(YXS1)', 140, 2.61],
      [],
      ['M2', 'Rosetta', 'ALL', '(YS2)', 177, 2.41],
    ]));
    assert.equal(r.rows.length, 2);
    assert.equal(blocking(r), 0);
  });

  test('a sheet that is not a laying sheet says so without refusing', async () => {
    const r = await extractLayingMarking(await sheet([['Notes'], ['Nothing tabular here']]));
    assert.equal(r.rows.length, 0);
    assert.equal(blocking(r), 0);
    assert.ok(
      r.issues.some((i) => /no laying & marking table was recognised/i.test(i.message)),
      'it must still explain itself',
    );
  });

  test('an empty file is refused with a sentence, not a crash', async () => {
    // Nothing to sniff and nothing to read. Said plainly rather thanfailing
    // somewhere deeper with a library error.
    await assert.rejects(
      () => extractLayingMarking(Buffer.alloc(0)),
      /not a spreadsheet or a PDF/i,
    );
  });
});

describe('laying sheets exported as CSV', () => {
  test('a CSV laying sheet reads the same as a workbook', async () => {
    // A factory exporting from its cutting system rather than Excel could not
    // import at all: the route refused anything that was not a zip.
    const csv = Buffer.from(
      'Marker No,Fabric,Panel,Size Ratio,Layers,Marker Length\n'
      + 'M9,Rosetta,ALL,(S1),150,2.75\n'
      + 'M10,Rosetta,ALL,(M1),90,3.10',
    );
    const r = await extractLayingMarking(csv);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0]!.markerNumber, 'M9');
    assert.equal(r.rows[0]!.layers, 150);
    assert.equal(r.rows[1]!.markerLengthM, 3.1);
    assert.equal(r.issues.filter((i) => i.level === 'ERROR').length, 0);
  });

  test('extra columns are read rather than ignored', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('L');
    ws.addRow(['Marker No', 'Fabric', 'Size Ratio', 'Layers', 'Marker Length', 'Nest Pcs']);
    ws.addRow(['M1', 'Rosetta', '(S1),(M1)', 140, 2.61, 700]);
    const r = await extractLayingMarking(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.equal(r.rows[0]!.nestPcs, 700);
  });

  test('layers written as text are still a number', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('L');
    ws.addRow(['Marker No', 'Fabric', 'Size Ratio', 'Layers', 'Marker Length']);
    ws.addRow(['M1', 'Rosetta', '(S1)', '140', '2.61']);
    const r = await extractLayingMarking(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.equal(r.rows[0]!.layers, 140);
    assert.equal(r.rows[0]!.markerLengthM, 2.61);
  });
});
