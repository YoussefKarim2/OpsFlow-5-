/**
 * What kind of document was uploaded, decided from its bytes.
 *
 * One place, because every import target asks the same question and the answer
 * must not differ between them. The name and the declared MIME type are claims
 * made by whoever uploaded the file; the first few bytes are not.
 *
 * The honest part of this module is what it refuses. `.xls` (the old binary
 * format) and `.ods` are real spreadsheet formats that ExcelJS cannot read, and
 * pretending otherwise would mean a parse error that reads like a bug rather
 * than an explanation the user can act on. They are named and rejected with the
 * one instruction that actually solves it.
 */

import { BadRequestError } from '../../errors.js';

export type FileKind = 'xlsx' | 'csv' | 'pdf';

/** `PK\x03\x04` — every .xlsx and .xlsm is a zip archive. */
function isZip(b: Buffer): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** `%PDF-` */
function isPdf(b: Buffer): boolean {
  return b.length >= 5 &&
    b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
}

/**
 * `\xD0\xCF\x11\xE0` — the OLE2 compound-document header, which is what a
 * pre-2007 .xls actually is. Detected only so it can be explained.
 */
function isLegacyXls(b: Buffer): boolean {
  return b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
}

/**
 * Whether a buffer is plausibly text, and therefore possibly CSV.
 *
 * A NUL byte in the first kilobyte means binary — no text format contains one.
 * Anything else is worth handing to the CSV reader, which will fail informatively
 * if it is not delimited data.
 */
function looksTextual(b: Buffer): boolean {
  const head = b.subarray(0, 1024);
  if (head.length === 0) return false;
  return !head.includes(0);
}

export function detectFileKind(buffer: Buffer, fileName = ''): FileKind {
  if (isPdf(buffer)) return 'pdf';
  if (isZip(buffer)) return 'xlsx';

  if (isLegacyXls(buffer)) {
    throw new BadRequestError(
      'This is an older .xls workbook, which cannot be read directly. ' +
      'Open it in Excel and use File → Save As to save it as .xlsx, then upload that.',
    );
  }

  // ODS is a zip too, so it is caught by the xlsx branch above and fails later
  // with a clearer message from the reader. Only a name can identify it here.
  if (/\.ods$/i.test(fileName)) {
    throw new BadRequestError(
      'OpenDocument (.ods) spreadsheets are not supported. ' +
      'Open the file and save it as .xlsx or .csv, then upload that.',
    );
  }

  if (looksTextual(buffer)) return 'csv';

  throw new BadRequestError(
    'That file is not a spreadsheet or a PDF — its contents do not match any format ' +
    'this system can read. Supported: .xlsx, .xlsm, .csv and text-based .pdf.',
  );
}

/** For error messages and the review screen. */
export const FILE_KIND_LABEL: Record<FileKind, string> = {
  xlsx: 'Excel workbook',
  csv: 'CSV file',
  pdf: 'PDF document',
};
