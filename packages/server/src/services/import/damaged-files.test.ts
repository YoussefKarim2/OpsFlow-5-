import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { extractFromPdf } from './pdf-extractor.js';
import { openWorkbook } from './open-workbook.js';
import { extractLayingMarking } from './laying-extractor.js';

/**
 * Files that are damaged, truncated, or simply not what their name claims.
 *
 * Every one of these is an ordinary thing for somebody to attach: a download
 * that stopped halfway, a .docx renamed to .xlsx, a PDF that is really a scan
 * of nothing. None of them may reach the user as a 500 with a library stack
 * trace in the body — which is exactly what three of them did.
 */
describe('files that are not what they claim to be', () => {
  const message = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); }
  };

  test('a truncated PDF is explained, not thrown raw', async () => {
    const m = await message(() => extractFromPdf(Buffer.from('%PDF-1.4\nbroken')));
    assert.match(m, /could not be opened/i);
    assert.doesNotMatch(m, /BaseException|at Object|\/Users\//, 'a library stack trace must not reach the user');
  });

  test('random bytes named .pdf are explained', async () => {
    const m = await message(() => extractFromPdf(Buffer.from([0, 255, 16, 153, 66])));
    assert.match(m, /could not be opened/i);
  });

  test('a corrupt zip is explained as not being a spreadsheet', async () => {
    // A .docx renamed .xlsx, or a half-downloaded workbook.
    const m = await message(() => openWorkbook(Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(200)])));
    assert.match(m, /could not be opened as a spreadsheet/i);
    assert.doesNotMatch(m, /central directory|ZipEntry/, 'the zip library\'s wording must not reach the user');
  });

  test('an empty buffer is explained rather than crashing', async () => {
    const m = await message(() => openWorkbook(Buffer.alloc(0)));
    assert.match(m, /could not be opened as a spreadsheet/i);
  });

  test('the laying reader explains a corrupt workbook the same way', async () => {
    const m = await message(() => extractLayingMarking(
      Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(200)]),
    ));
    assert.match(m, /could not be opened as a spreadsheet/i);
  });

  test('plain text reaching the laying reader yields nothing, and does not throw', async () => {
    // It sniffs as CSV, which is correct — a laying sheet exported from a
    // cutting system is CSV. A CSV of prose simply has no lays in it, and the
    // route's own guard is what refuses a text file wearing a .xlsx name.
    const r = await extractLayingMarking(Buffer.from('not a workbook at all'));
    assert.equal(r.rows.length, 0);
    assert.equal(r.issues.filter((i) => i.level === 'ERROR').length, 0);
  });
});

/**
 * A zip built by hand, so a test can say what its table of contents claims
 * (`claim`) independently of what is really inside — which is exactly what a
 * hostile file does.
 */
function zipOf(entries: Array<{ name: string; data: Buffer; claim?: number }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = deflateRawSync(e.data);
    const name = Buffer.from(e.name);
    const size = e.claim ?? e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(size, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const sheetXml = (rows: number) => Buffer.from(
  '<?xml version="1.0"?><worksheet><sheetData>'
  + Array.from({ length: rows }, (_, i) => `<row r="${i + 1}"><c><v>1</v></c></row>`).join('')
  + '</sheetData></worksheet>',
);

describe('a workbook too large to open safely is refused before it is opened', () => {
  // The audit's bomb: a 6 MB upload holding a 57 MB, 200,000-row sheet took
  // ExcelJS 25 seconds and 1.2 GB — and the start-up fill read it every boot.
  test('more than 50,000 rows on a sheet', async () => {
    const buf = zipOf([{ name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') }, { name: 'xl/worksheets/sheet1.xml', data: sheetXml(50_001) }]);
    const started = Date.now();
    await assert.rejects(openWorkbook(buf), /too large to read.*50,001 rows/s);
    assert.ok(Date.now() - started < 3000, 'refused from the zip, not after ExcelJS has built it');
  });

  test('a table of contents that unpacks to more than 100 MB', async () => {
    const buf = zipOf([
      { name: 'xl/sharedStrings.xml', data: Buffer.from('<sst/>'), claim: 90 * 1024 * 1024 },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml(10), claim: 20 * 1024 * 1024 },
    ]);
    await assert.rejects(openWorkbook(buf), /too large to read.*110 MB of data/s);
  });

  test('one sheet over 60 MB', async () => {
    const buf = zipOf([{ name: 'xl/worksheets/sheet1.xml', data: sheetXml(10), claim: 61 * 1024 * 1024 }]);
    await assert.rejects(openWorkbook(buf), /one sheet alone is 61 MB/);
  });

  test('a sheet whose table of contents lies about its size', async () => {
    const buf = zipOf([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(61 * 1024 * 1024, 0x20), claim: 1024 }]);
    await assert.rejects(openWorkbook(buf), /unpacks to more than 60 MB/);
  });

  test('an ordinary workbook is untouched by the check', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('PO').addRow(['Colour', 'S']);
    const opened = await openWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.equal(opened.worksheets[0]!.name, 'PO');
  });
});
