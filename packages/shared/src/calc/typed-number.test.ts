import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isTypeableFigure, readTypedNumber, typedNumberOrNull } from './typed-number.js';

describe('reading a typed figure', () => {
  test('plain numbers read as themselves', () => {
    for (const [t, n] of [['0', 0], ['12', 12], ['1.5', 1.5], ['0.05', 0.05], ['.5', 0.5], ['1.', 1], ['-3.25', -3.25], [' 7 ', 7]] as const) {
      assert.deepEqual(readTypedNumber(t), { ok: true, value: n }, t);
    }
  });

  test('blank is no value, not zero', () => {
    assert.deepEqual(readTypedNumber(''), { ok: true, value: null });
    assert.deepEqual(readTypedNumber('   '), { ok: true, value: null });
  });

  test('a comma between thousands is read as one', () => {
    assert.equal(typedNumberOrNull('1,000'), 1000);
    assert.equal(typedNumberOrNull('12,345.50'), 12345.5);
    assert.equal(typedNumberOrNull('1,234,567'), 1234567);
    assert.equal(typedNumberOrNull('-1,000.5'), -1000.5);
  });

  test('a comma anywhere else is refused, never reinterpreted', () => {
    for (const t of ['7,25', '12,5', '1,00', '1000,000', ',5', '1,', '1,2345']) {
      const r = readTypedNumber(t);
      assert.equal(r.ok, false, t);
      if (!r.ok) assert.match(r.reason, /point for decimals/);
      assert.equal(typedNumberOrNull(t), null);
    }
  });

  test('other text is refused', () => {
    for (const t of ['abc', '-', '.', '1.2.3', '1e3', 'Infinity', '$5']) {
      assert.equal(readTypedNumber(t).ok, false, t);
    }
  });
});

describe('what a figure field accepts while typing', () => {
  test('half-finished figures pass', () => {
    for (const t of ['', '-', '1.', '.', '1,', '1,000', '0.0', '-1,000.5']) assert.equal(isTypeableFigure(t), true, t);
  });
  test('letters and second points are blocked', () => {
    for (const t of ['a', '1a', '1.2.3', '1-', '$1', '1e3']) assert.equal(isTypeableFigure(t), false, t);
  });
});
