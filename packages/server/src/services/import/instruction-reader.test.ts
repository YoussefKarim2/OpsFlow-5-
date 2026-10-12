/**
 * Reading special-instructions spreadsheets.
 *
 * Run: npm test -w @opsflow/server
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

import { readInstructionSheet, readInstructionSheets, readInstructionFile, inferDepartments, type SheetIn } from './instruction-reader.js';

const v = (text: string) => ({ text, formula: false });
const f = (text: string) => ({ text, formula: true });
const row = (...cells: string[]) => cells.map(v);

describe('a names-and-numbers list', () => {
  const sheet: SheetIn = {
    name: 'Sheet1',
    rows: [
      row('UFEC 2026 – back printing'),
      row(''),
      row('Player Name', 'No.', 'Size', 'Qty'),
      row('Ronaldo', '7', 'L', '2'),
      row('Salah', '11', 'M', '1'),
      row('', '99', 'XL', '1'),
      row('Total', '', '', '4'),
      row('Print in white, 25 cm numbers'),
    ],
  };
  const [d] = readInstructionSheet(sheet, 'ufec names.xlsx');

  test('every player becomes a row', () => {
    assert.deepEqual(d!.lines.map((l) => [l.name, l.number, l.sizeLabel, l.qty]), [
      ['Ronaldo', '7', 'L', 2], ['Salah', '11', 'M', 1], [null, '99', 'XL', 1],
    ]);
  });
  test('the sheet title and the note around the table fill the title and text', () => {
    assert.equal(d!.title, 'UFEC 2026 – back printing');
    assert.equal(d!.body, 'Print in white, 25 cm numbers');
  });
  test('printing and packing are told', () => {
    for (const dep of ['EXTERNAL_OPS', 'PACKING', 'COORDINATOR', 'PRODUCTION_MANAGER']) assert.ok(d!.visibleTo.includes(dep as never), dep);
  });
});

describe('a list of instructions', () => {
  const sheet: SheetIn = {
    name: 'Instructions',
    rows: [
      row('Title', 'Instruction', 'Department'),
      row('Neck tape', 'Neck tape runs the other way on all sizes', 'Production'),
      row('', 'Fold with the crest showing, one polybag per shirt'),
      row('Labels', 'Size label 2 cm below the neck', 'Production, QC'),
    ],
  };
  const drafts = readInstructionSheet(sheet, 'x.xlsx');

  test('one draft per row', () => assert.equal(drafts.length, 3));
  test('a department column is used as written', () => {
    assert.deepEqual(drafts[0]!.visibleTo, ['PRODUCTION_MANAGER']);
    assert.deepEqual(drafts[2]!.visibleTo, ['PRODUCTION_MANAGER', 'QUALITY']);
  });
  test('without one, departments follow the text, and a missing title comes from it', () => {
    assert.ok(drafts[1]!.visibleTo.includes('PACKING'));
    assert.equal(drafts[1]!.title, 'Fold with the crest showing, one polybag per shirt');
  });
});

describe('the factory workbook\'s Custom Instructions sheet', () => {
  const sheet: SheetIn = {
    name: 'Custom Instructions_Coordinator',
    rows: [
      [f('🖼 Customer Reference')],
      [v(''), v(''), v('Po No :'), f('89-39'), f('89-39'), v(''), v('Gender :'), f('Unisex')],
      [v(''), v(''), v('Season'), f('Summer 26')],
      [v(''), v(''), v('Sublimation print on front and back, Pantone 186 C'), v('Sublimation print on front and back, Pantone 186 C')],
      [v(''), v(''), v('طباعة الاسم والرقم على الظهر')],
      [v(''), v(''), v('Approved')],
      [v(''), v(''), v('A.S')],
    ],
  };
  const [d] = readInstructionSheets([{ name: 'Order Details_Coordinator', rows: [row('PO', '1')] }, sheet], 'age.xlsx');

  test('only the instructions sheet is read, without the copied header or the signature', () => {
    assert.equal(d!.body, 'Sublimation print on front and back, Pantone 186 C\nطباعة الاسم والرقم على الظهر');
    assert.ok(!/89-39|Unisex|Approved/.test(d!.body + d!.title));
  });
  test('printing in either language reaches external operations', () => {
    assert.ok(d!.visibleTo.includes('EXTERNAL_OPS'));
  });
});

describe('departments from the text', () => {
  test('several subjects, several departments', () => {
    const d = inferDepartments('Cut on the grain, embroider the badge, pack in cartons of 20');
    for (const x of ['CUTTING_MARKER', 'EXTERNAL_OPS', 'PACKING']) assert.ok(d.includes(x as never), x);
  });
});

describe('a real file', () => {
  test('an .xlsx is opened and read', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Names');
    ws.addRow(['Name', 'Number', 'Size']);
    ws.addRow(['Messi', 10, 'S']);
    ws.addRow(['Kane', 9, 'XL']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const [d] = await readInstructionFile(buf, 'names.xlsx');
    assert.deepEqual(d!.lines.map((l) => [l.name, l.number, l.sizeLabel]), [['Messi', '10', 'S'], ['Kane', '9', 'XL']]);
  });

  test('a PDF is refused with a sentence', async () => {
    await assert.rejects(readInstructionFile(Buffer.from('%PDF-1.4 x'), 'x.pdf'), /Excel file/);
  });
});

describe('a note typed under the names list', () => {
  test('is the instruction text, not a player', () => {
    const [d] = readInstructionSheet({
      name: 'Printing',
      rows: [
        row('UFEC away – back printing'), row(''),
        row('Player Name', 'No.', 'Size', 'Qty'),
        row('RONALDO', '7', 'L', '1'), row('KANE', '9', 'XL', '2'), row(''),
        row('White vinyl, numbers 25 cm high, names 7 cm, centred 8 cm below the collar'),
      ],
    }, 'names.xlsx');
    assert.equal(d!.lines.length, 2);
    assert.equal(d!.title, 'UFEC away – back printing');
    assert.equal(d!.body, 'White vinyl, numbers 25 cm high, names 7 cm, centred 8 cm below the collar');
  });
});
