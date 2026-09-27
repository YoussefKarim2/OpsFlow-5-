import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentDisposition, decodeUploadName } from './upload-name.js';

const asMulterSeesIt = (name: string) => Buffer.from(name, 'utf8').toString('latin1');

test('an Arabic filename survives the upload', () => {
  assert.equal(decodeUploadName(asMulterSeesIt('فاتورة é.pdf')), 'فاتورة é.pdf');
});

test('a plain ASCII filename is untouched', () => {
  assert.equal(decodeUploadName('PO 85 - A302059B.xlsx'), 'PO 85 - A302059B.xlsx');
});

test('a genuine latin1 name that is not UTF-8 underneath is left alone', () => {
  assert.equal(decodeUploadName('café.pdf'), 'café.pdf');
});

test('a name already decoded properly is left alone', () => {
  assert.equal(decodeUploadName('فاتورة.pdf'), 'فاتورة.pdf');
});

test('the download header carries the real name and an ASCII fallback', () => {
  const h = contentDisposition('inline', 'فاتورة "1".pdf');
  assert.match(h, /^inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  assert.ok(!/[^\x00-\xff]/.test(h), 'Node refuses a header holding characters above U+00FF');
  assert.ok(h.endsWith(encodeURIComponent('فاتورة "1".pdf')));
});
