import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickReinspectionTarget } from './reinspection.js';

const d = (s: string) => new Date(s);
const fail = (id: string, day: string, created = day) => ({ id, inspectionDate: d(day), createdAt: d(created) });

describe('a re-inspection is linked to the failure it answers', () => {
  test('the first audit after a FAIL re-inspects it', () => {
    assert.equal(pickReinspectionTarget([fail('f1', '2026-10-20')], new Set(), d('2026-10-21')), 'f1');
  });

  test('no earlier FAIL means a first inspection', () => {
    assert.equal(pickReinspectionTarget([], new Set(), d('2026-10-21')), null);
    // A FAIL dated after this audit is not one it could have answered.
    assert.equal(pickReinspectionTarget([fail('f1', '2026-10-25')], new Set(), d('2026-10-21')), null);
  });

  test('a FAIL already re-inspected is not answered twice', () => {
    // The regression this guards: every audit after one FAIL would otherwise
    // count as a re-inspection, and a fresh first inspection weeks later too.
    assert.equal(pickReinspectionTarget([fail('f1', '2026-10-20')], new Set(['f1']), d('2026-10-30')), null);
  });

  test('the latest open FAIL wins, same-day ties by when it was recorded', () => {
    const fails = [
      fail('old', '2026-10-10'),
      fail('a', '2026-10-20', '2026-10-20T08:00:00Z'),
      fail('b', '2026-10-20', '2026-10-20T15:00:00Z'),
    ];
    assert.equal(pickReinspectionTarget(fails, new Set(), d('2026-10-20')), 'b');
    assert.equal(pickReinspectionTarget(fails, new Set(['b']), d('2026-10-20')), 'a');
  });
});
