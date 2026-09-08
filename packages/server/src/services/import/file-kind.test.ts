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
});
