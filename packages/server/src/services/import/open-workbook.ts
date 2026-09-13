import ExcelJS from 'exceljs';
import { BadRequestError } from '../../errors.js';

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
 */
export async function readCsvWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const { Readable } = await import('node:stream');
  try {
    await wb.csv.read(Readable.from(buffer.toString('utf8')));
  } catch {
    throw new BadRequestError('This CSV could not be read — check it is a plain comma-separated file.');
  }
  if (wb.worksheets.length > 0 && !wb.worksheets[0]!.name) wb.worksheets[0]!.name = 'CSV';
  return wb;
}
