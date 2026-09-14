import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatCell, isTypeableNumber } from './costing-format.js';

describe('how a costing field reads at rest', () => {
  test('money, percentages and counts are formatted for reading', () => {
    assert.equal(formatCell(1260, 'money'), '$1,260.00');
    assert.equal(formatCell(-10, 'percent', 1), '-10.0%');
    assert.equal(formatCell(1972, 'number'), '1,972');
    assert.equal(formatCell(3.4210526, 'number', 1), '3.4');
  });

  test('text reads as itself, and an empty one as a dash', () => {
    assert.equal(formatCell('ProTime', 'text'), 'ProTime');
    assert.equal(formatCell('', 'text'), '—');
    assert.equal(formatCell(null, 'text'), '—');
  });

  test('nothing to show reads as "Not calculated", never as an error', () => {
    for (const kind of ['money', 'percent', 'number'] as const) {
      const text = formatCell(null, kind);
      assert.equal(text, 'Not calculated');
      assert.doesNotMatch(text, /NaN|Infinity|#DIV|undefined|null/);
    }
  });

  test('a value that could not render is treated as no value', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(formatCell(bad, 'money'), 'Not calculated');
      assert.equal(formatCell(bad, 'percent'), 'Not calculated');
      assert.equal(formatCell(bad, 'number'), 'Not calculated');
    }
  });
});

describe('what a numeric field lets through mid-typing', () => {
  test('a number being typed is accepted at every keystroke', () => {
    for (const step of ['', '1', '1.', '1.5', '-', '-1', '-1.', '-1.25', '.5', '0']) {
      assert.ok(isTypeableNumber(step), `${JSON.stringify(step)} should be typeable`);
    }
  });

  test('what could never be a number is refused', () => {
    for (const junk of ['abc', '1.2.3', '1-2', '$5', '1,000', '--1', 'e']) {
      assert.equal(isTypeableNumber(junk), false, `${JSON.stringify(junk)} should not be accepted`);
    }
  });
});
