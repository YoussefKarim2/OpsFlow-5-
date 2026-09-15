import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatCell } from './costing-format.js';

/**
 * Does the widest figure a costing column can hold actually fit in it?
 *
 * The costing table's columns were sized by eye and the unit price did not
 * fit: it carries four decimals, so `$1,234.5678` is eleven characters, and
 * the column left room for about nine. The number went in and could not be
 * read back.
 *
 * The budget below is arithmetic, not taste. A column's declared Tailwind
 * width, less the cell's own padding, less the input's padding, divided by the
 * width of a tabular digit at the size the table renders. If somebody later
 * takes the unit price to six decimals, or narrows a column, this fails before
 * the number disappears again.
 */
const REM = 16;
const TD_PADDING = 12 * 2;      // .td px-3
const INPUT_PADDING = 6 * 2;    // px-1.5 inside the cell
const DIGIT = 7.3;              // 12px tabular-nums, measured against Inter's advance

/** How many characters a column can show, given its Tailwind width class. */
function capacity(widthRem: number, extraPadding = 0): number {
  const px = widthRem * REM - TD_PADDING - INPUT_PADDING - extraPadding;
  return Math.floor(px / DIGIT);
}

/** Column → declared width in rem, as the header sets it. */
const COLUMNS = {
  planned: 7,        // w-28
  actualCons: 8,     // w-32
  unit: 6,           // w-24
  unitPrice: 9,      // w-36
  cost: 9,           // w-36
} as const;

describe('every costing column fits the widest value it can hold', () => {
  test('a unit price with four decimals fits — the figure that did not', () => {
    const widest = formatCell(1234.5678, 'money', 4);
    assert.equal(widest, '$1,234.5678');
    assert.ok(widest.length <= capacity(COLUMNS.unitPrice),
      `"${widest}" is ${widest.length} characters, column holds ${capacity(COLUMNS.unitPrice)}`);
  });

  test('a six-figure unit price still fits', () => {
    const widest = formatCell(123456.789, 'money', 4);
    assert.ok(widest.length <= capacity(COLUMNS.unitPrice),
      `"${widest}" is ${widest.length}, column holds ${capacity(COLUMNS.unitPrice)}`);
  });

  test('a large cost fits', () => {
    for (const v of [0.01, 12.5, 1234.56, 99999.99, 1234567.89]) {
      const text = formatCell(v, 'money');
      assert.ok(text.length <= capacity(COLUMNS.cost),
        `"${text}" is ${text.length}, column holds ${capacity(COLUMNS.cost)}`);
    }
  });

  test('a consumption with two decimals fits, however large', () => {
    for (const v of [0.25, 1.5, 1194, 250000, 9999999]) {
      const text = formatCell(v, 'number', 2);
      assert.ok(text.length <= capacity(COLUMNS.actualCons),
        `"${text}" is ${text.length}, column holds ${capacity(COLUMNS.actualCons)}`);
    }
  });

  test('the planned column fits the same figures', () => {
    for (const v of [1194, 250000]) {
      const text = formatCell(v, 'number', 2);
      assert.ok(text.length <= capacity(COLUMNS.planned),
        `"${text}" is ${text.length}, column holds ${capacity(COLUMNS.planned)}`);
    }
  });

  test('the units actually used fit', () => {
    // A unit is free text, so there is no bound — these are the ones the bill
    // of materials and the workbook use.
    for (const unit of ['MET', 'PCS', 'KG', 'LOT', 'DAY', 'Roll', 'met.', 'YARD', 'DOZEN']) {
      assert.ok(unit.length <= capacity(COLUMNS.unit),
        `"${unit}" is ${unit.length}, column holds ${capacity(COLUMNS.unit)}`);
    }
  });

  test('an overridden cell still fits, with the revert arrow taking its room', () => {
    // The arrow costs pr-6 rather than pr-1.5, so 18px more.
    const widest = formatCell(1234.5678, 'money', 4);
    assert.ok(widest.length <= capacity(COLUMNS.unitPrice, 18),
      `"${widest}" is ${widest.length}, overridden column holds ${capacity(COLUMNS.unitPrice, 18)}`);
  });

  test('the budget the columns were sized against, for the record', () => {
    // Fails loudly if a column is narrowed without anyone noticing.
    assert.equal(capacity(COLUMNS.unitPrice), 14);
    assert.equal(capacity(COLUMNS.cost), 14);
    assert.equal(capacity(COLUMNS.actualCons), 12);
    assert.equal(capacity(COLUMNS.planned), 10);
    assert.equal(capacity(COLUMNS.unit), 8);
  });
});
