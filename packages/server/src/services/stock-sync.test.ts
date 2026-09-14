import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseAxisName, matchAxis, type AxisOption } from './stock-sync.js';

/**
 * The Stock step takes colour and size as typed text; the matrix holds them as
 * references. The join between them is the name, and a join that is too strict
 * is how a recorded stock row comes to subtract from nothing at all.
 */
describe('matching a typed colour or size to the order', () => {
  const colors: AxisOption[] = [
    { id: 'c1', name: 'SKY BLUE' },
    { id: 'c2', name: 'ATH. GOLD' },
  ];
  const sizes: AxisOption[] = [
    { id: 's1', name: 'YS', longName: 'YOUTH SMALL' },
    { id: 's2', name: 'M', longName: null },
  ];

  test('an exact name matches', () => {
    assert.equal(matchAxis('SKY BLUE', colors)?.id, 'c1');
  });

  test('case and stray spacing do not decide whether stock counts', () => {
    assert.equal(matchAxis('sky blue', colors)?.id, 'c1');
    assert.equal(matchAxis('  Sky   Blue ', colors)?.id, 'c1');
  });

  test('a size may be named either way round', () => {
    assert.equal(matchAxis('YS', sizes)?.id, 's1');
    assert.equal(matchAxis('youth small', sizes)?.id, 's1');
  });

  test('a name that is not on the order matches nothing', () => {
    // The caller refuses these rather than storing stock that cannot be found.
    assert.equal(matchAxis('NAVY', colors), null);
    assert.equal(matchAxis('XXL', sizes), null);
  });

  test('an empty name is not a match for the first entry', () => {
    assert.equal(matchAxis('', colors), null);
    assert.equal(matchAxis('   ', colors), null);
  });

  test('a size with no long form is not matched by a null', () => {
    assert.equal(matchAxis('M', sizes)?.id, 's2');
  });

  test('normalisation is what the matching is built on', () => {
    assert.equal(normaliseAxisName('  sky   blue '), 'SKY BLUE');
    assert.equal(normaliseAxisName('M'), 'M');
  });
});
