/**
 * Shared upload validation for every Excel import entry point.
 *
 * Split out of `routes/import.ts` so a second import flow (Laying & Marking)
 * does not duplicate the security-sensitive checks below — a path-traversal
 * guard and a magic-byte check are exactly the kind of thing that must have
 * one implementation, not two that can drift apart.
 */

import multer from 'multer';
import { BadRequestError } from '../../errors.js';

/** MIME types a browser or Excel actually sends for a workbook. */
const WORKBOOK_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel',
  'application/octet-stream', // some clients send nothing more specific
  'application/zip',          // xlsx *is* a zip; a few clients say so
]);

export const workbookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // multer's callback is an overload pair: cb(error) to reject, or
    // cb(null, true) to accept. Passing both an error and a flag is invalid.

    // A filename is attacker-controlled: reject any path separator or traversal
    // before it can reach a storage key.
    if (/[/\\]|\.\./.test(file.originalname)) {
      cb(new BadRequestError('That file name is not allowed.'));
      return;
    }
    if (!/\.(xlsx|xlsm)$/i.test(file.originalname)) {
      cb(new BadRequestError('Only .xlsx and .xlsm files can be imported.'));
      return;
    }
    if (!WORKBOOK_MIME_TYPES.has(file.mimetype)) {
      cb(new BadRequestError(`"${file.mimetype}" is not a spreadsheet. Upload an .xlsx or .xlsm file.`));
      return;
    }
    cb(null, true);
  },
});

/**
 * The extension and the declared MIME type are both claims made by the client.
 * The first four bytes are not: every .xlsx and .xlsm is a zip archive, so it
 * begins `PK\x03\x04`. Anything else is something wearing a spreadsheet's name.
 */
export function assertLooksLikeWorkbook(buffer: Buffer): void {
  const isZip =
    buffer.length >= 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b &&
    buffer[2] === 0x03 && buffer[3] === 0x04;
  if (!isZip) {
    throw new BadRequestError(
      'That file is not a valid .xlsx or .xlsm workbook — its contents do not match its name. ' +
      'If it is an older .xls file, open it in Excel and save it as .xlsx first.',
    );
  }
}
