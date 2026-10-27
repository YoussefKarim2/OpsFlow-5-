import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import { BadRequestError } from '../../errors.js';

/**
 * How big a workbook may be once unzipped, and how long one sheet may run.
 *
 * An .xlsx is a zip of XML, and XML compresses a hundredfold: a 6 MB upload,
 * well inside the 25 MB limit, held a 57 MB sheet of 200,000 rows that took
 * ExcelJS 25 seconds and 1.2 GB to open — enough to take the server down, and
 * the start-up fill re-read it on every boot. No purchase order is anywhere
 * near these sizes (the largest real one is 114 rows); they are there so a
 * file that is not one is refused before it is opened rather than after.
 */
export const MAX_WORKBOOK_UNZIPPED_BYTES = 100 * 1024 * 1024;
export const MAX_SHEET_XML_BYTES = 60 * 1024 * 1024;
export const MAX_SHEET_ROWS = 50_000;

/** One entry of a zip's central directory: what it is called and how it is stored. */
interface ZipEntry { name: string; method: number; compressedSize: number; uncompressedSize: number; localOffset: number }

/**
 * The zip's table of contents, read without unpacking anything.
 *
 * Null when the buffer is not a readable zip — ExcelJS is left to say so in
 * its own (already translated) way. A ZIP64 size (0xFFFFFFFF) is reported as
 * it is, which is larger than any limit and so refused.
 */
function zipEntries(buf: Buffer): ZipEntry[] | null {
  // The end-of-central-directory record is in the last 22 bytes plus at most
  // a 64 KB comment.
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null;
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    entries.push({
      name: buf.toString('utf8', at + 46, at + 46 + nameLength),
      method: buf.readUInt16LE(at + 10),
      compressedSize: buf.readUInt32LE(at + 20),
      uncompressedSize: buf.readUInt32LE(at + 24),
      localOffset: buf.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * How many `<row` elements a sheet's XML holds, unzipped on its own.
 *
 * `'oversize'` when it unzips to more than the byte limit after all — the
 * table of contents is the file's own claim, and a hostile one can lie. Null
 * when the entry cannot be unzipped here, which ExcelJS then reports.
 */
function sheetRowCount(buf: Buffer, entry: ZipEntry): number | 'oversize' | null {
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) return null;
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  let xml: Buffer;
  if (entry.method === 0) xml = data;
  else if (entry.method === 8) {
    try {
      xml = inflateRawSync(data, { maxOutputLength: MAX_SHEET_XML_BYTES });
    } catch (err) {
      return (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'oversize' : null;
    }
  } else return null;
  let rows = 0;
  for (let i = xml.indexOf('<row'); i !== -1; i = xml.indexOf('<row', i + 4)) {
    // `<row ` or `<row>`, not `<rowBreaks`.
    const next = xml[i + 4];
    if (next === 0x20 || next === 0x3e) rows++;
  }
  return rows;
}

/**
 * Refuse a workbook too large to open safely, before ExcelJS is given it.
 *
 * Read from the zip's own table of contents, so a refused file costs nothing
 * to look at. A sheet within the byte limit is still counted row by row —
 * unzipping one sheet is cheap next to ExcelJS building a cell object for
 * every value in it.
 */
export function assertWorkbookWithinLimits(buffer: Buffer): void {
  const entries = zipEntries(buffer);
  if (!entries) return; // not a readable zip: ExcelJS explains that below
  const sheets = entries.filter((e) => /^xl\/worksheets\/[^/]+\.xml$/i.test(e.name));
  const total = entries.reduce((a, e) => a + e.uncompressedSize, 0);
  const tooLarge = (what: string) => new BadRequestError(
    `This workbook is too large to read — ${what}. A purchase order is a few hundred rows at most; `
    + 'check this is the right file, or copy the order sheet into a new workbook and upload that.',
  );
  if (total > MAX_WORKBOOK_UNZIPPED_BYTES) {
    throw tooLarge(`it unpacks to ${Math.round(total / 1048576)} MB of data, over the ${MAX_WORKBOOK_UNZIPPED_BYTES / 1048576} MB limit`);
  }
  for (const sheet of sheets) {
    if (sheet.uncompressedSize > MAX_SHEET_XML_BYTES) {
      throw tooLarge(`one sheet alone is ${Math.round(sheet.uncompressedSize / 1048576)} MB, over the ${MAX_SHEET_XML_BYTES / 1048576} MB limit`);
    }
    const rows = sheetRowCount(buffer, sheet);
    if (rows === 'oversize') {
      throw tooLarge(`one sheet alone unpacks to more than ${MAX_SHEET_XML_BYTES / 1048576} MB`);
    }
    if (rows != null && rows > MAX_SHEET_ROWS) {
      throw tooLarge(`one sheet has ${rows.toLocaleString('en-US')} rows, over the ${MAX_SHEET_ROWS.toLocaleString('en-US')}-row limit`);
    }
  }
}

/**
 * Open a workbook, or say plainly that it is not one.
 *
 * ExcelJS reads .xlsx as the zip archive it is, and throws its own errors when
 * that archive is truncated or is not an archive at all — "Corrupted zip: can't
 * find end of central directory". Those reached the error handler unrecognised
 * and came back as a 500 with a library stack trace in the body.
 *
 * A half-downloaded spreadsheet, or a .docx renamed to .xlsx, is an ordinary
 * mistake. It deserves a sentence telling the person what to do, and the same
 * sentence wherever in the importer it happens — which is why every load goes
 * through here rather than each caller guessing.
 */
export async function loadWorkbook(wb: ExcelJS.Workbook, buffer: Buffer): Promise<void> {
  // Outside the try: "too large" is its own answer, not "could not be opened".
  assertWorkbookWithinLimits(buffer);
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestError(
      'This file could not be opened as a spreadsheet — it looks incomplete, or it is '
      + 'another kind of document with a .xlsx name. Re-save it as .xlsx and try again.',
    );
  }
}

export async function openWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await loadWorkbook(wb, buffer);
  return wb;
}

/**
 * A CSV read as a one-sheet workbook, so every reader downstream is identical.
 *
 * ExcelJS leaves the sheet unnamed, and an unnamed sheet reports oddly
 * everywhere it is displayed, so it gets one.
 *
 * Its values go through `csvValue` rather than ExcelJS's own mapping, which
 * ran `Number()` on every field: PO 000123 became 123, a jersey number 07
 * became 7, a style 2E5 became 200000 — and a European "1.200" became 1.2
 * pieces.
 */
export async function readCsvWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const { Readable } = await import('node:stream');
  const text = decodeCsv(buffer);
  const delimiter = csvDelimiter(text);
  const european = csvIsEuropean(text, delimiter);
  try {
    await wb.csv.read(Readable.from(text), {
      parserOptions: { delimiter },
      map: (value: string) => csvValue(value, european),
    });
  } catch {
    throw new BadRequestError('This CSV could not be read — check it is a plain comma-separated file.');
  }
  if (wb.worksheets.length > 0 && !wb.worksheets[0]!.name) wb.worksheets[0]!.name = 'CSV';
  return wb;
}

/**
 * A CSV's text, in whichever encoding it was saved.
 *
 * Excel's "Unicode Text" is UTF-16 with a byte-order mark, and "CSV (Comma
 * delimited)" on Arabic Windows is Windows-1256 — read as UTF-8, every Arabic
 * colour came out as "����", and two different colours merged into one row
 * because they were the same row of question marks. UTF-8 is tried first, and
 * is right whenever it decodes cleanly; a replacement character means it did
 * not, and the Arabic code page is what an Egyptian office's Excel writes.
 */
export function decodeCsv(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('windows-1256').decode(buffer);
}

/** "1.200", "1.200,50", "2,35": numbers written the European way. */
const EURO_NUMBER = /^-?\d{1,3}(\.\d{3})+(,\d{1,2})?$|^-?\d+,\d{1,2}$/;
/** "1,200", "1,200.50", "2.35": the same numbers written the English way. */
const ANGLO_NUMBER = /^-?\d{1,3}(,\d{3})+(\.\d{1,2})?$|^-?\d+\.\d{1,2}$/;

/**
 * Whether a CSV writes its numbers the European way.
 *
 * Decided over the whole file, as `normaliseEuropeanNumbers` decides it for a
 * PDF: whichever style has more fields wins. A semicolon-separated file is
 * Excel in a comma-decimal locale, so there a tie goes European too — a file
 * whose only decimals are "2,35"s and whose thousands are "1,200"s cannot be
 * told apart any other way.
 */
export function csvIsEuropean(text: string, delimiter: string): boolean {
  let euro = 0, anglo = 0;
  for (const line of text.split(/\r?\n/)) {
    for (const raw of line.split(delimiter)) {
      const field = raw.trim().replace(/^"(.*)"$/, '$1');
      if (EURO_NUMBER.test(field)) euro++;
      else if (ANGLO_NUMBER.test(field)) anglo++;
    }
  }
  if (euro === 0) return false;
  return delimiter === ';' ? euro >= anglo : euro > anglo;
}

/** The Excel error strings ExcelJS's own mapping turned into error cells. */
const CSV_ERRORS = new Set(['#N/A', '#REF!', '#NAME?', '#DIV/0!', '#NULL!', '#VALUE!', '#NUM!']);

/**
 * One CSV field as a cell value.
 *
 * Text stays text unless it is plainly a number. "Plainly" excludes a leading
 * zero ("000123", "07") and an exponent ("2E5", "1e3"): both are how an
 * identifier — a PO, a style, a jersey number — looks, and `Number()` threw
 * the identifier away. A quantity written that way still reads, because every
 * reader's own `toNumber` accepts text. In a European file "1.200" is 1200 and
 * "2,35" is 2.35, as the PDF reader reads them.
 *
 * Dates stay text too: ExcelJS turned "2026-09-15" into local midnight, and
 * the readers' `safeDate` reads the text itself, the same way it reads a date
 * typed on the review screen.
 */
export function csvValue(raw: string, european = false): ExcelJS.CellValue {
  if (raw === '') return null;
  const t = raw.trim();
  if (european && EURO_NUMBER.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) && !/^[+-]?0\d/.test(t)) return Number(t);
  if (CSV_ERRORS.has(raw)) return { error: raw } as ExcelJS.CellErrorValue;
  if (raw === 'true' || raw === 'false') return raw === 'true';
  return raw;
}

/**
 * The character that separates a CSV's columns.
 *
 * Excel saves a CSV with semicolons wherever the decimal separator is a comma
 * — most of Europe — and the file is still called a CSV. Read with commas it
 * was one column wide, and "no table could be found". Decided from the header
 * line: whichever of semicolon, tab and comma splits it into the most fields.
 */
export function csvDelimiter(text: string): ',' | ';' | '\t' {
  const head = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const count = (ch: string) => head.split(ch).length - 1;
  const candidates: Array<[',' | ';' | '\t', number]> = [[',', count(',')], [';', count(';')], ['\t', count('\t')]];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0]![1] > 0 ? candidates[0]![0] : ',';
}
