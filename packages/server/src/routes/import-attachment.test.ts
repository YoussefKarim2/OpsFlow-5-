import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { mimeForImport } from './import.js';

/**
 * The document an order was imported from is filed against that order, and the
 * MIME type is what decides whether clicking it opens the customer's PO in the
 * browser or downloads an unnamed blob. ImportJob never stored one - the
 * extractor works from bytes and had no use for it - so it is derived from the
 * same sniffing the importer already did.
 */
describe('the imported document, filed as an attachment', () => {
  test('a PDF is typed so the browser opens it in its viewer', () => {
    // The header is what the sniffer reads; the extension alone is not trusted.
    const pdf = Buffer.from('%PDF-1.7\n');
    assert.equal(mimeForImport(pdf, 'meyba-po.pdf'), 'application/pdf');
  });

  test('a CSV is typed as text, not as a spreadsheet', () => {
    const csv = Buffer.from('Colour,S,M,L\nNavy,10,20,30\n');
    assert.equal(mimeForImport(csv, 'order.csv'), 'text/csv');
  });

  test('a workbook gets the xlsx type', async () => {
    // A real workbook, because the sniffer reads the zip's contents rather
    // than trusting the PK signature — which is the behaviour we want.
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Order').addRow(['Colour', 'S', 'M']);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    assert.equal(
      mimeForImport(xlsx, 'order.xlsx'),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});
