import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { evaluateCell } from './formula-eval.js';

function sheet(): { wb: ExcelJS.Workbook; ws: ExcelJS.Worksheet } {
  const wb = new ExcelJS.Workbook();
  const other = wb.addWorksheet("PO 84873 Tran'mer");
  other.getCell('B2').value = 40;
  const ws = wb.addWorksheet('invoice');
  ws.getCell('A1').value = 10; ws.getCell('A2').value = 20; ws.getCell('A3').value = 'text';
  return { wb, ws };
}
const calc = (ws: ExcelJS.Worksheet, formula: string) => {
  ws.getCell('Z99').value = { formula } as ExcelJS.CellValue;
  return evaluateCell(ws, ws.getCell('Z99'));
};

describe('the formula calculator', () => {
  test('arithmetic, precedence and functions', () => {
    const { ws } = sheet();
    assert.deepEqual(calc(ws, 'A1+A2*2'), { value: 50 });
    assert.deepEqual(calc(ws, '(A1+A2)/4'), { value: 7.5 });
    // As in Excel, the minus sign binds before the power: -10^2 is 100.
    assert.deepEqual(calc(ws, '-A1^2'), { value: 100 });
    assert.deepEqual(calc(ws, 'SUM(A1:A3)'), { value: 30 });
    assert.deepEqual(calc(ws, 'ROUNDUP(A2/3,0)'), { value: 7 });
    assert.deepEqual(calc(ws, 'ROUND(2.345,2)'), { value: 2.35 });
    assert.deepEqual(calc(ws, 'MAX(A1,A2,5)'), { value: 20 });
    assert.deepEqual(calc(ws, '$A$1*3'), { value: 30 });
  });

  test('other sheets, quoted names and chained formulas', () => {
    const { ws } = sheet();
    assert.deepEqual(calc(ws, "'PO 84873 Tran''mer'!B2/4"), { value: 10 });
    ws.getCell('B1').value = { formula: 'A1*2' } as ExcelJS.CellValue;
    assert.deepEqual(calc(ws, 'B1+1'), { value: 21 });
  });

  test('text joined with &', () => {
    const { ws } = sheet();
    assert.deepEqual(calc(ws, 'A1&" carton NW: "&A2&" KG."'), { value: '10 carton NW: 20 KG.' });
  });

  test('an empty cell is a value; what it cannot do is undefined', () => {
    const { ws } = sheet();
    assert.deepEqual(calc(ws, 'C7'), { value: null });
    assert.equal(calc(ws, 'VLOOKUP(1,A1:A2,1,0)'), undefined);
    assert.equal(calc(ws, 'A1/0'), undefined);
    assert.equal(calc(ws, "'Missing'!A1"), undefined);
    ws.getCell('C1').value = { formula: 'C2' } as ExcelJS.CellValue;
    ws.getCell('C2').value = { formula: 'C1' } as ExcelJS.CellValue;
    assert.equal(calc(ws, 'C1'), undefined);
  });
});
