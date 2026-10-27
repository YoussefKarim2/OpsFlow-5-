/**
 * File-type detection, and what it refuses.
 *
 * The refusals matter more than the acceptances here. `.xls` and `.ods` are
 * real formats a customer will genuinely send, and the difference between "this
 * is an older .xls, save it as .xlsx" and a parser stack trace is the whole
 * difference between a user solving the problem and filing a bug.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { detectFileKind } from './file-kind.js';
import { isUnsafeUploadName } from './upload-guard.js';

const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const pdf = Buffer.from('%PDF-1.7\n...');
const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const csv = Buffer.from('PO,Colour,Size,Qty\n1234,Red,S,100\n');

describe('recognising a file from its bytes', () => {
  test('an xlsx is a zip', () => assert.equal(detectFileKind(zip, 'order.xlsx'), 'xlsx'));
  test('an xlsm is the same zip', () => assert.equal(detectFileKind(zip, 'order.xlsm'), 'xlsx'));
  test('a PDF is recognised by its header', () => assert.equal(detectFileKind(pdf, 'po.pdf'), 'pdf'));
  test('delimited text is CSV', () => assert.equal(detectFileKind(csv, 'order.csv'), 'csv'));

  test('the name does not decide it', () => {
    // A PDF renamed .xlsx is still a PDF, and is read as one rather than
    // handed to a spreadsheet parser to fail on.
    assert.equal(detectFileKind(pdf, 'order.xlsx'), 'pdf');
  });
});

describe('refusing what cannot be read, in words that help', () => {
  test('an old .xls says how to convert it', () => {
    assert.throws(() => detectFileKind(xls, 'order.xls'), /Save As.*\.xlsx/s);
  });

  test('an .ods says how to convert it', () => {
    assert.throws(() => detectFileKind(Buffer.from('anything'), 'order.ods'), /\.xlsx or \.csv/);
  });

  test('binary rubbish is named as unreadable, not parsed', () => {
    assert.throws(
      () => detectFileKind(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]), 'photo.jpg'),
      /not a spreadsheet or a PDF/,
    );
  });

  test('an empty file is refused rather than read as empty data', () => {
    assert.throws(() => detectFileKind(Buffer.alloc(0), 'empty.csv'));
  });

  test('a password-protected .xlsx is called that, not an older .xls', () => {
    // Office wraps an encrypted workbook in the OLE2 container an .xls uses,
    // with a stream named EncryptedPackage.
    const encrypted = Buffer.concat([xls, Buffer.alloc(64), Buffer.from('EncryptedPackage', 'utf16le')]);
    assert.throws(() => detectFileKind(encrypted, 'order.xlsx'), (e: Error) => /password-protected/.test(e.message) && !/older \.xls/.test(e.message));
  });
});

describe('UTF-16 text is a CSV', () => {
  test('little-endian, with its byte-order mark', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Colour,Size,Qty\r\nNavy,S,10\r\n', 'utf16le')]);
    assert.equal(detectFileKind(buf, 'order.csv'), 'csv');
  });
  test('big-endian, with its byte-order mark', () => {
    const le = Buffer.from('Colour,Size,Qty\r\n', 'utf16le');
    const be = Buffer.from(le.map((_, i) => le[i ^ 1]!));
    assert.equal(detectFileKind(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), 'order.csv'), 'csv');
  });
});

describe('the upload name check', () => {
  test('two dots inside a name are not traversal', () => {
    assert.equal(isUnsafeUploadName('PO..final.xlsx'), false);
    assert.equal(isUnsafeUploadName('order v2..csv'), false);
  });
  test('a path, or a name that starts as one, is refused', () => {
    for (const n of ['../etc/passwd', '..\\boot.ini', '..', '..xlsx', 'a/b.xlsx', 'a\\b.xlsx']) {
      assert.equal(isUnsafeUploadName(n), true, n);
    }
  });
});
