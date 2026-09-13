import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
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

  test('the laying reader gets the same explanation', async () => {
    const m = await message(() => extractLayingMarking(Buffer.from('not a workbook at all')));
    assert.match(m, /could not be opened as a spreadsheet/i);
  });
});
